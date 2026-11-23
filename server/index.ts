import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { login, logout, requireAdmin, requireUser, type AppEnv } from './auth.ts'
import { config } from './config.ts'
import { audit, db, initDb, tx } from './db.ts'
import { advanceJob, createJobs, getJob, JobError, MAX_IMAGE_BYTES, ownProject, saveFrame, trimVideo, uploadImage, upscaleImage, upscaleVideo, recordBlocked, recoverInterruptedJobs, type CreateJobInput, type JobInputs, type JobRow } from './jobs.ts'
import * as ledger from './ledger.ts'
import { frameAt, joinClips } from './media.ts'
import { hashBcryptPassword, isBcryptHash, isValidNewPassword } from './passwords.ts'
import { checkPrompt } from './policy.ts'
import { estimate, IMAGE_UPSCALE_SIZES, imageUpscaleCredits, loadPricing, type ImageUpscaleSize, normalize, pricingRules, upscaleOptions, type GenerationParams, type Resolution } from './pricing.ts'
import { mp4Seconds } from './provider.ts'
import { VOICES, voicePreset, voiceSample, voiceText } from './voices.ts'

const app = new Hono<AppEnv>()

app.onError((err, c) => {
  if (err instanceof JobError || err instanceof ledger.InsufficientCredits) return c.json({ error: err.message }, 400)
  console.error(err)
  return c.json({ error: err.message || 'Something went wrong' }, 500)
})

// Fly's health check, every 30s. It must not touch the database: a query that often keeps the
// Neon compute awake around the clock, so it never scales to zero.
app.get('/healthz', (c) => c.text('ok'))

app.post('/api/login', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>()
  const user = await login(c, email ?? '', password ?? '')
  if (!user) return c.json({ error: 'Wrong email or password' }, 401)
  await audit(user.id, 'login')
  return c.json({ user })
})

app.post('/api/logout', async (c) => {
  await logout(c)
  return c.json({ ok: true })
})

const api = new Hono<AppEnv>()
api.use('*', requireUser)

// Real clip length for the timeline. Files never change, so each is read once.
const secondsCache = new Map<string, number | null>()
function clipSeconds(file: string, mime: string): number | null {
  if (mime !== 'video/mp4') return null
  if (!secondsCache.has(file)) {
    try { secondsCache.set(file, mp4Seconds(readFileSync(join(config.dataDir, 'media', file)))) } catch { secondsCache.set(file, null) }
  }
  return secondsCache.get(file) ?? null
}

type AssetRow = { id: number; job_id: number; file: string; mime: string; mock: number; favorite: boolean; name: string | null }

// Assets for many jobs in one query instead of one per job.
async function assetsFor(jobIds: number[], deleted: boolean) {
  const map = new Map<number, AssetRow[]>()
  if (!jobIds.length) return map
  const rows = await db.all<AssetRow>('SELECT id, job_id, file, mime, mock, favorite, name FROM assets WHERE job_id = ANY(?) AND (deleted_at IS NOT NULL) = ? ORDER BY id', jobIds, deleted)
  for (const r of rows) map.set(r.job_id, [...(map.get(r.job_id) ?? []), r])
  return map
}

function toView(job: JobRow, assets: AssetRow[], deleted: boolean) {
  const policy = job.policy ? JSON.parse(job.policy) : null
  const params = JSON.parse(job.params)
  const real = job.kind === 'video' && assets[0] ? clipSeconds(assets[0].file, assets[0].mime) : null
  return {
    id: job.id, kind: job.kind, modelKey: job.model_key, params, status: job.status,
    seconds: real ?? params.durationSeconds ?? null,
    upscaleOptions: real == null ? [] : upscaleOptions(params.resolution, real).map(({ resolution, credits }) => ({ resolution, credits })),
    sourceJobId: job.source_job_id, sceneId: job.scene_id, batchId: job.batch_id ?? job.id,
    promptOriginal: job.prompt_original, promptFinal: job.prompt_final,
    estimatedCost: job.estimated_cost, actualCost: job.actual_cost, error: job.error,
    needsReview: !!policy?.needsReview, reason: policy?.reasonEn || null,
    createdAt: job.created_at, completedAt: job.completed_at,
    assets: assets.map((a) => ({ id: a.id, url: `/media/${a.file}${deleted ? '?bin=1' : ''}`, mime: a.mime, mock: !!a.mock, favorite: a.favorite, name: a.name })),
    hasInputs: !!job.inputs && job.inputs !== '{}',
  }
}

async function jobViews<T extends JobRow>(jobs: T[], deleted = false) {
  const assets = await assetsFor(jobs.map((j) => j.id), deleted)
  return jobs.map((j) => toView(j, assets.get(j.id) ?? [], deleted))
}

const jobView = async (job: JobRow) => (await jobViews([job]))[0]

api.get('/me', async (c) => {
  const user = c.get('user')
  const w = await ledger.userWalletId(user.id)
  return c.json({
    user,
    balance: await ledger.balance(w),
    spentToday: await ledger.spentSince(w, ledger.startOfToday()),
    allowance: await ledger.dailyAllowance(user.id),
    mock: config.mock,
    pricing: pricingRules(),
    imageUpscale: IMAGE_UPSCALE_SIZES.map((size) => ({ size, credits: imageUpscaleCredits(size) })),
  })
})

api.post('/estimate', async (c) => {
  const params = normalize(await c.req.json<GenerationParams>())
  return c.json({ params, ...estimate(params) })
})

api.post('/prompt/check', async (c) => {
  const user = c.get('user')
  const { prompt, editImage } = await c.req.json<{ prompt: string; editImage?: boolean }>()
  if (!prompt?.trim()) return c.json({ error: 'Write a prompt first' }, 400)
  const check = await checkPrompt(user.id, prompt.trim(), editImage === true)
  if (!check.allowed) await recordBlocked(user.id, prompt.trim(), check)
  return c.json(check)
})

api.post('/jobs', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<CreateJobInput>()
  if (body.images !== undefined) return c.json({ error: 'Use the image video endpoint' }, 400)
  // A list: "×N videos" starts several jobs at once.
  return c.json(await jobViews(await createJobs(user.id, body)))
})

api.post('/jobs/:id/frame', async (c) => {
  const { seconds } = await c.req.json<{ seconds: number }>()
  return c.json(await jobView(await saveFrame(c.get('user').id, Number(c.req.param('id')), Number(seconds))), 201)
})

api.post('/jobs/:id/trim', async (c) => {
  const { start, end } = await c.req.json<{ start: number; end: number }>()
  return c.json(await jobView(await trimVideo(c.get('user').id, Number(c.req.param('id')), Number(start), Number(end))), 201)
})

api.post('/jobs/from-images', async (c) => {
  const body = await c.req.json<CreateJobInput>()
  if (!body.images) return c.json({ error: 'Choose images first' }, 400)
  return c.json(await jobViews(await createJobs(c.get('user').id, body)))
})

api.post('/images/upload', bodyLimit({
  maxSize: MAX_IMAGE_BYTES,
  onError: (c) => c.json({ error: 'Choose an image up to 20 MB' }, 413),
}), async (c) => {
  const bytes = Buffer.from(await c.req.arrayBuffer())
  const cropOf = c.req.query('cropOf')
  return c.json(await jobView(await uploadImage(c.get('user').id, bytes, cropOf === undefined ? undefined : Number(cropOf), c.req.query('project'))), 201)
})

api.post('/assets/:id/upscale', async (c) => {
  const { size } = await c.req.json<{ size: ImageUpscaleSize }>()
  return c.json(await jobView(await upscaleImage(c.get('user').id, Number(c.req.param('id')), size)), 201)
})

// A name for an image or video, used to mention it with @. An empty name clears it.
api.put('/assets/:id/name', async (c) => {
  const { name } = await c.req.json<{ name?: unknown }>()
  if (typeof name !== 'string') return c.json({ error: 'Write a name' }, 400)
  const clean = name.replace(/\s+/g, ' ').replace(/@/g, '').trim()
  if (clean.length > 40) return c.json({ error: 'Keep the name to 40 characters' }, 400)
  const updated = await db.run('UPDATE assets SET name = ? WHERE id = ? AND user_id = ?', clean || null, collectionId(c.req.param('id')), c.get('user').id)
  return updated ? c.json({ name: clean || null }) : c.json({ error: 'Item not found' }, 404)
})

// Favorites: a star on one image or video.
for (const [method, value] of [['put', true], ['delete', false]] as const) {
  api[method]('/assets/:id/favorite', async (c) => {
    const updated = await db.run('UPDATE assets SET favorite = ? WHERE id = ? AND user_id = ?', value, collectionId(c.req.param('id')), c.get('user').id)
    return updated ? c.json({ ok: true }) : c.json({ error: 'Item not found' }, 404)
  })
}

api.post('/jobs/:id/upscale', async (c) => {
  const { resolution } = await c.req.json<{ resolution: Resolution }>()
  return c.json(await jobView(await upscaleVideo(c.get('user').id, Number(c.req.param('id')), resolution)), 201)
})

api.get('/jobs', async (c) => {
  const user = c.get('user')
  const project = await ownProject(user.id, c.req.query('project'))
  if (c.req.query('favorites') === '1') {
    const rows = await db.all<JobRow>(`SELECT j.* FROM jobs j WHERE j.user_id = ? AND j.project_id = ? AND j.status = 'succeeded'
      AND EXISTS (SELECT 1 FROM assets a WHERE a.job_id = j.id AND a.deleted_at IS NULL AND a.favorite) ORDER BY j.id DESC`, user.id, project.id)
    return c.json((await jobViews(rows)).map((job) => ({ ...job, assets: job.assets.filter((asset) => asset.favorite) })))
  }
  const rows = await db.all<JobRow>("SELECT j.* FROM jobs j WHERE j.user_id = ? AND j.project_id = ? AND j.status != 'blocked' AND j.dismissed_at IS NULL AND (j.status != 'succeeded' OR EXISTS (SELECT 1 FROM assets a WHERE a.job_id = j.id AND a.deleted_at IS NULL)) ORDER BY j.id DESC LIMIT 60", user.id, project.id)
  return c.json(await jobViews(rows))
})

// The media a job's prompt used, for Reuse prompt. Items moved to the Bin are left out and counted.
api.get('/jobs/:id/inputs', async (c) => {
  const user = c.get('user')
  const job = await getJob(Number(c.req.param('id')))
  if (!job || job.user_id !== user.id) return c.json({ error: 'Not found' }, 404)
  const inputs = (job.inputs ? JSON.parse(job.inputs) : {}) as JobInputs
  const wanted = [...inputs.editImages ?? [], ...inputs.images?.items ?? []]
  const found = wanted.length ? await db.all<{ id: number; job_id: number; file: string }>(`SELECT a.id, a.job_id, a.file FROM assets a JOIN jobs j ON j.id = a.job_id
    WHERE a.id = ANY(?) AND a.user_id = ? AND a.deleted_at IS NULL AND j.status = 'succeeded'`, wanted.map((item) => item.assetId), user.id) : []
  let missing = 0
  const resolve = (items: { jobId: number; assetId: number }[]) => items.flatMap(({ assetId }) => {
    const asset = found.find((a) => a.id === assetId)
    if (!asset) { missing++; return [] }
    return [{ jobId: asset.job_id, assetId, url: `/media/${asset.file}` }]
  })
  const editImages = resolve(inputs.editImages ?? [])
  const images = inputs.images ? { mode: inputs.images.mode, items: resolve(inputs.images.items) } : null
  let source = null
  const sourceId = inputs.editVideoJobId ?? inputs.sourceJobId
  if (sourceId != null) {
    const row = await getJob(sourceId)
    const view = row && row.user_id === user.id && row.status === 'succeeded' ? await jobView(row) : null
    if (view?.assets.length && (inputs.sourceAssetId == null || view.assets.some((a) => a.id === inputs.sourceAssetId))) {
      source = { job: view, assetId: inputs.sourceAssetId, mode: inputs.editVideoJobId != null ? 'edit' : view.kind === 'video' ? 'extend' : 'animate' }
    } else missing++
  }
  const live = inputs.characterIds?.length
    ? (await db.all<{ id: number }>('SELECT id FROM characters WHERE id = ANY(?) AND user_id = ? AND deleted_at IS NULL', inputs.characterIds, user.id)).map((r) => r.id)
    : []
  const characterIds = inputs.characterIds?.filter((id) => live.includes(id)) ?? []
  missing += (inputs.characterIds?.length ?? 0) - characterIds.length
  return c.json({ editImages, images, source, characterIds, missing })
})

// Removes a failed card from the gallery. Only failed jobs: finished media goes to the Bin instead.
api.delete('/jobs/:id', async (c) => {
  const updated = await db.run("UPDATE jobs SET dismissed_at = ? WHERE id = ? AND user_id = ? AND status = 'failed'",
    Date.now(), collectionId(c.req.param('id')), c.get('user').id)
  return updated ? c.json({ ok: true }) : c.json({ error: 'Only failed items can be removed' }, 400)
})

api.get('/jobs/:id', async (c) => {
  const user = c.get('user')
  const job = await getJob(Number(c.req.param('id')))
  if (!job || (job.user_id !== user.id && user.role !== 'admin')) return c.json({ error: 'Not found' }, 404)
  return c.json(await jobView(await advanceJob(job.id)))
})

type Collection = { id: number; name: string }

function collectionId(value: string) {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new JobError('Invalid collection or asset')
  return id
}

api.get('/collections', async (c) => {
  const project = await ownProject(c.get('user').id, c.req.query('project'))
  return c.json(await db.all<Collection>(
    'SELECT id, name FROM media_collections WHERE user_id = ? AND project_id = ? AND deleted_at IS NULL ORDER BY id', c.get('user').id, project.id))
})

api.post('/collections', async (c) => {
  const { projectId } = await c.req.json<{ projectId?: number }>().catch(() => ({}) as { projectId?: number })
  const project = await ownProject(c.get('user').id, projectId)
  const name = 'Untitled collection'
  const id = await db.insert('INSERT INTO media_collections (user_id, name, project_id) VALUES (?, ?, ?)', c.get('user').id, name, project.id)
  return c.json({ id, name }, 201)
})

api.patch('/collections/:id', async (c) => {
  const { name } = await c.req.json<{ name?: unknown }>()
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new JobError('Enter a collection name up to 80 characters')
  const id = collectionId(c.req.param('id'))
  const updated = await db.run('UPDATE media_collections SET name = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL', name.trim(), id, c.get('user').id)
  return updated ? c.json({ id, name: name.trim() }) : c.json({ error: 'Collection not found' }, 404)
})

api.get('/collections/:id/jobs', async (c) => {
  const id = collectionId(c.req.param('id'))
  const userId = c.get('user').id
  if (!await db.get('SELECT id FROM media_collections WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId)) {
    return c.json({ error: 'Collection not found' }, 404)
  }
  const selected = await db.all<{ asset_id: number; job_id: number }>(`
    SELECT a.id AS asset_id, a.job_id FROM media_collection_assets m JOIN assets a ON a.id = m.asset_id
    WHERE m.collection_id = ? AND a.user_id = ? AND a.deleted_at IS NULL`, id, userId)
  if (!selected.length) return c.json([])
  const ids = new Set(selected.map((asset) => asset.asset_id))
  const rows = await db.all<JobRow>("SELECT * FROM jobs WHERE user_id = ? AND status = 'succeeded' AND id = ANY(?) ORDER BY id DESC",
    userId, [...new Set(selected.map((asset) => asset.job_id))])
  return c.json((await jobViews(rows)).map((job) => ({ ...job, assets: job.assets.filter((asset) => ids.has(asset.id)) })))
})

api.put('/collections/:id/assets/:assetId', async (c) => {
  const id = collectionId(c.req.param('id'))
  const assetId = collectionId(c.req.param('assetId'))
  const userId = c.get('user').id
  const target = await db.get(`SELECT m.id FROM media_collections m JOIN assets a ON a.id = ? AND a.user_id = m.user_id
    JOIN jobs j ON j.id = a.job_id AND j.user_id = m.user_id
    WHERE m.id = ? AND m.user_id = ? AND m.deleted_at IS NULL AND a.deleted_at IS NULL AND j.status = 'succeeded'`, assetId, id, userId)
  if (!target) return c.json({ error: 'Collection or asset not found' }, 404)
  await db.run('INSERT INTO media_collection_assets (collection_id, asset_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, assetId)
  return c.json({ ok: true })
})

api.delete('/collections/:id/assets/:assetId', async (c) => {
  await db.run(`DELETE FROM media_collection_assets m USING media_collections c
    WHERE m.collection_id = c.id AND c.id = ? AND c.user_id = ? AND c.deleted_at IS NULL AND m.asset_id = ?`,
  collectionId(c.req.param('id')), c.get('user').id, collectionId(c.req.param('assetId')))
  return c.json({ ok: true })
})

api.get('/bin', async (c) => {
  const userId = c.get('user').id
  const project = await ownProject(userId, c.req.query('project'))
  const [rows, collections] = await Promise.all([
    db.all<JobRow>(`SELECT j.* FROM jobs j WHERE j.user_id = ? AND j.project_id = ? AND EXISTS
      (SELECT 1 FROM assets a WHERE a.job_id = j.id AND a.deleted_at IS NOT NULL) ORDER BY j.id DESC`, userId, project.id),
    db.all<Collection>('SELECT id, name FROM media_collections WHERE user_id = ? AND project_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC', userId, project.id),
  ])
  return c.json({ jobs: await jobViews(rows, true), collections })
})

for (const [path, table] of [['assets', 'assets'], ['collections', 'media_collections']] as const) {
  api.delete(`/${path}/:id`, async (c) => {
    const id = collectionId(c.req.param('id'))
    const updated = await db.run(`UPDATE ${table} SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ? AND user_id = ?`,
      Date.now(), id, c.get('user').id)
    return updated ? c.json({ ok: true }) : c.json({ error: 'Item not found' }, 404)
  })
  api.post(`/${path}/:id/restore`, async (c) => {
    const id = collectionId(c.req.param('id'))
    const updated = await db.run(`UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND user_id = ?`, id, c.get('user').id)
    return updated ? c.json({ ok: true }) : c.json({ error: 'Item not found' }, 404)
  })
}

api.get('/ledger', async (c) => {
  const user = c.get('user')
  const rows = await db.all(`SELECT e.id, e.type, e.amount, e.reason, e.created_at AS "createdAt", e.job_id AS "jobId", j.prompt_original AS prompt
    FROM ledger_entries e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.wallet_id = ? ORDER BY e.id DESC LIMIT 80`, await ledger.userWalletId(user.id))
  return c.json(rows)
})

api.get('/topups', async (c) => {
  const user = c.get('user')
  return c.json(await db.all('SELECT * FROM topup_requests WHERE user_id = ? ORDER BY id DESC LIMIT 20', user.id))
})

api.post('/topups', async (c) => {
  const user = c.get('user')
  const { amount, reason } = await c.req.json<{ amount: number; reason: string }>()
  if (!(amount > 0) || !reason?.trim()) return c.json({ error: 'Add an amount and a reason' }, 400)
  await db.run('INSERT INTO topup_requests (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)', user.id, Math.round(amount), reason.trim(), Date.now())
  await audit(user.id, 'topup.requested', { amount, reason })
  return c.json({ ok: true })
})

// ---------- scenes (timeline) ----------
// A scene is clips played one after another, like Flow's Scenebuilder.
type SceneRow = { id: number; user_id: number; name: string; created_at: number; updated_at: number }

async function ownScene(userId: number, id: number) {
  const scene = await db.get<SceneRow>('SELECT * FROM scenes WHERE id = ? AND user_id = ?', id, userId)
  if (!scene) throw new JobError('Scene not found')
  return scene
}

async function sceneView(scene: SceneRow) {
  const clips = await db.all<JobRow & { clip_id: number; trim_start: number | null; trim_end: number | null }>(`SELECT c.id AS clip_id, c.trim_start, c.trim_end, j.* FROM scene_clips c JOIN jobs j ON j.id = c.job_id
    WHERE c.scene_id = ? AND j.dismissed_at IS NULL AND (j.status != 'succeeded' OR EXISTS (SELECT 1 FROM assets a WHERE a.job_id = j.id AND a.deleted_at IS NULL)) ORDER BY c.position, c.id`, scene.id)
  const views = await jobViews(clips)
  return {
    id: scene.id, name: scene.name, createdAt: scene.created_at, updatedAt: scene.updated_at,
    // trimStart/trimEnd: the part of the clip the scene plays, in seconds of the source.
    clips: clips.map((j, i) => ({ clipId: j.clip_id, job: views[i], trimStart: j.trim_start ?? 0, trimEnd: j.trim_end })),
  }
}

// Shortest piece a trim or split may leave, in seconds.
const MIN_CLIP = 0.5

async function sceneClip(sceneId: number, clipId: number) {
  const clip = await db.get<{ id: number; job_id: number; position: number; trim_start: number | null; trim_end: number | null }>(
    'SELECT id, job_id, position, trim_start, trim_end FROM scene_clips WHERE id = ? AND scene_id = ?', clipId, sceneId)
  if (!clip) throw new JobError('Clip not found')
  const job = (await jobViews([(await getJob(clip.job_id))!]))[0]
  const length = job.seconds ?? 0
  return { clip, length, start: clip.trim_start ?? 0, end: clip.trim_end ?? length }
}

// Keep only [start, end] of a clip. Times are in seconds of the source clip.
api.post('/scenes/:id/clips/:clipId/trim', async (c) => {
  const scene = await ownScene(c.get('user').id, Number(c.req.param('id')))
  const { start, end } = await c.req.json<{ start: number; end: number }>()
  const { clip, length } = await sceneClip(scene.id, Number(c.req.param('clipId')))
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e > length + 0.05 || e - s < MIN_CLIP) {
    throw new JobError(`Keep at least ${MIN_CLIP} seconds of the clip`)
  }
  await db.run('UPDATE scene_clips SET trim_start = ?, trim_end = ? WHERE id = ?', s > 0.01 ? s : null, e < length - 0.01 ? e : null, clip.id)
  await touchScene(scene.id)
  return c.json(await sceneView(scene))
})

// Cut a clip in two at `at` (seconds of the source clip); both halves stay in place.
api.post('/scenes/:id/clips/:clipId/split', async (c) => {
  const scene = await ownScene(c.get('user').id, Number(c.req.param('id')))
  const { at } = await c.req.json<{ at: number }>()
  const { clip, start, end } = await sceneClip(scene.id, Number(c.req.param('clipId')))
  const t = Number(at)
  if (!Number.isFinite(t) || t - start < MIN_CLIP || end - t < MIN_CLIP) throw new JobError(`Each part needs at least ${MIN_CLIP} seconds`)
  await tx(async () => {
    await db.run('UPDATE scene_clips SET position = position + 1 WHERE scene_id = ? AND position > ?', scene.id, clip.position)
    await db.run('INSERT INTO scene_clips (scene_id, job_id, position, trim_start, trim_end) VALUES (?, ?, ?, ?, ?)',
      scene.id, clip.job_id, clip.position + 1, t, clip.trim_end)
    await db.run('UPDATE scene_clips SET trim_end = ? WHERE id = ?', t, clip.id)
    await touchScene(scene.id)
  })
  return c.json(await sceneView(scene))
})

const touchScene = (id: number) => db.run('UPDATE scenes SET updated_at = ? WHERE id = ?', Date.now(), id)

async function addClip(userId: number, sceneId: number, jobId: number) {
  const job = await getJob(jobId)
  if (!job || job.user_id !== userId || job.kind !== 'video' || job.status === 'blocked') throw new JobError('Only your own videos can go in a scene')
  if (job.status === 'succeeded' && !await db.get('SELECT id FROM assets WHERE job_id = ? AND deleted_at IS NULL LIMIT 1', jobId)) {
    throw new JobError('Restore this video from the Bin before adding it to a scene')
  }
  const end = (await db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM scene_clips WHERE scene_id = ?', sceneId))!.p
  await db.run('INSERT INTO scene_clips (scene_id, job_id, position) VALUES (?, ?, ?)', sceneId, jobId, end)
  await touchScene(sceneId)
}

api.get('/scenes', async (c) => {
  const project = await ownProject(c.get('user').id, c.req.query('project'))
  const rows = await db.all<SceneRow>('SELECT * FROM scenes WHERE user_id = ? AND project_id = ? ORDER BY updated_at DESC', c.get('user').id, project.id)
  return c.json(await Promise.all(rows.map(sceneView)))
})

api.post('/scenes', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ name?: string; jobIds?: number[]; projectId?: number }>().catch(() => ({}) as { name?: string; jobIds?: number[]; projectId?: number })
  const project = await ownProject(user.id, body.projectId)
  const count = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM scenes WHERE user_id = ? AND project_id = ?', user.id, project.id))!.n
  const now = Date.now()
  const id = await tx(async () => {
    const id = await db.insert('INSERT INTO scenes (user_id, name, created_at, updated_at, project_id) VALUES (?, ?, ?, ?, ?)',
      user.id, body.name?.trim().slice(0, 80) || `Scene ${count + 1}`, now, now, project.id)
    for (const jobId of body.jobIds ?? []) await addClip(user.id, id, Number(jobId))
    return id
  })
  await audit(user.id, 'scene.created', { sceneId: id })
  return c.json(await sceneView(await ownScene(user.id, id)))
})

api.get('/scenes/:id', async (c) => c.json(await sceneView(await ownScene(c.get('user').id, Number(c.req.param('id'))))))

api.post('/scenes/:id', async (c) => {
  const scene = await ownScene(c.get('user').id, Number(c.req.param('id')))
  const { name } = await c.req.json<{ name: string }>()
  if (name?.trim()) await db.run('UPDATE scenes SET name = ?, updated_at = ? WHERE id = ?', name.trim().slice(0, 80), Date.now(), scene.id)
  return c.json(await sceneView(await ownScene(scene.user_id, scene.id)))
})

api.delete('/scenes/:id', async (c) => {
  const scene = await ownScene(c.get('user').id, Number(c.req.param('id')))
  await tx(async () => {
    await db.run('DELETE FROM scene_clips WHERE scene_id = ?', scene.id)
    await db.run('UPDATE jobs SET scene_id = NULL WHERE scene_id = ?', scene.id)
    await db.run('DELETE FROM scenes WHERE id = ?', scene.id)
  })
  await audit(scene.user_id, 'scene.deleted', { sceneId: scene.id })
  return c.json({ ok: true })
})

api.post('/scenes/:id/clips', async (c) => {
  const user = c.get('user')
  const scene = await ownScene(user.id, Number(c.req.param('id')))
  const { jobId } = await c.req.json<{ jobId: number }>()
  await addClip(user.id, scene.id, Number(jobId))
  return c.json(await sceneView(scene))
})

api.delete('/scenes/:id/clips/:clipId', async (c) => {
  const scene = await ownScene(c.get('user').id, Number(c.req.param('id')))
  await db.run('DELETE FROM scene_clips WHERE id = ? AND scene_id = ?', Number(c.req.param('clipId')), scene.id)
  await touchScene(scene.id)
  return c.json(await sceneView(scene))
})

// The scene's clips in their new order, as clip ids.
api.post('/scenes/:id/order', async (c) => {
  const scene = await ownScene(c.get('user').id, Number(c.req.param('id')))
  const { clipIds } = await c.req.json<{ clipIds: number[] }>()
  await tx(async () => {
    for (const [i, id] of clipIds.entries()) await db.run('UPDATE scene_clips SET position = ? WHERE id = ? AND scene_id = ?', i, Number(id), scene.id)
    await touchScene(scene.id)
  })
  return c.json(await sceneView(scene))
})

// The whole scene as one MP4, joined in timeline order.
api.get('/scenes/:id/export', async (c) => {
  const user = c.get('user')
  const scene = await sceneView(await ownScene(user.id, Number(c.req.param('id'))))
  const ready = scene.clips.filter((x) => x.job.status === 'succeeded' && x.job.assets[0])
  if (!ready.length) return c.json({ error: 'The scene has no finished clips yet' }, 400)
  if (ready.some((x) => x.job.assets[0].mime !== 'video/mp4')) {
    return c.json({ error: 'Mock clips are pictures, so they can’t be joined into one video. Export works with real videos.' }, 400)
  }
  const parts = ready.map((x) => ({ file: x.job.assets[0].url.replace('/media/', ''), start: x.trimStart, end: x.trimEnd }))
  const mp4 = await joinClips(parts, ready[0].job.params.aspectRatio)
  await audit(user.id, 'scene.exported', { sceneId: scene.id, clips: parts.length })
  const name = scene.name.replace(/[^\w -]/g, '').trim() || 'scene'
  return c.body(new Uint8Array(mp4), 200, { 'content-type': 'video/mp4', 'content-disposition': `attachment; filename="${name}.mp4"` })
})

// ---------- projects (Home) ----------
const projectName = (value: unknown) => {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 80) throw new JobError('Enter a project name up to 80 characters')
  return name
}

type ProjectListRow = { id: number; name: string; created_at: number; updated_at: number; last_job: number | null; items: number; cover: string | null }

const projectView = (row: ProjectListRow) => {
  const [file, mime] = row.cover?.split('|') ?? []
  return {
    id: row.id, name: row.name, createdAt: row.created_at, updatedAt: Math.max(row.updated_at, row.last_job ?? 0), items: row.items,
    cover: file ? { url: `/media/${file}`, mime } : null,
  }
}

const PROJECT_SELECT = `SELECT p.id, p.name, p.created_at, p.updated_at,
  (SELECT MAX(j.created_at) FROM jobs j WHERE j.project_id = p.id) AS last_job,
  (SELECT COUNT(*) FROM assets a JOIN jobs j ON j.id = a.job_id WHERE j.project_id = p.id AND a.deleted_at IS NULL) AS items,
  (SELECT a.file || '|' || a.mime FROM assets a JOIN jobs j ON j.id = a.job_id WHERE j.project_id = p.id AND a.deleted_at IS NULL ORDER BY a.id DESC LIMIT 1) AS cover
  FROM projects p`

const oneProject = async (id: number) => projectView((await db.get<ProjectListRow>(`${PROJECT_SELECT} WHERE p.id = ?`, id))!)

api.get('/projects', async (c) => {
  const rows = await db.all<ProjectListRow>(`${PROJECT_SELECT} WHERE p.user_id = ?`, c.get('user').id)
  return c.json(rows.map(projectView).sort((a, b) => b.updatedAt - a.updatedAt))
})

api.get('/projects/:id', async (c) => c.json(await oneProject((await ownProject(c.get('user').id, c.req.param('id'))).id)))

api.post('/projects', async (c) => {
  const user = c.get('user')
  const { name } = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown })
  const now = Date.now()
  const id = await db.insert('INSERT INTO projects (user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', user.id, projectName(name), now, now)
  await audit(user.id, 'project.created', { projectId: id })
  return c.json(await oneProject(id), 201)
})

api.patch('/projects/:id', async (c) => {
  const project = await ownProject(c.get('user').id, c.req.param('id'))
  const { name } = await c.req.json<{ name?: unknown }>()
  await db.run('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', projectName(name), Date.now(), project.id)
  return c.json(await oneProject(project.id))
})

// ---------- voices ----------
// Preset voices for characters, with a short spoken sample of each (made once, then kept).
api.get('/voices', (c) => c.json(VOICES.map(({ id, label, labelAr, gender, group, style }) => ({ id, label, labelAr, gender, group, style }))))

api.get('/voices/:id/sample', async (c) => {
  if (!voicePreset(c.req.param('id'))) return c.json({ error: 'Voice not found' }, 404)
  try {
    const wav = await voiceSample(c.req.param('id'))
    return c.body(new Uint8Array(wav), 200, { 'content-type': 'audio/wav', 'cache-control': 'private, max-age=86400' })
  } catch (err) {
    console.error('[voices] sample failed', (err as Error).message)
    return c.json({ error: 'Couldn’t make the voice sample. Try again.' }, 502)
  }
})

// ---------- characters ----------
// A person to reuse across projects: name, 1–3 reference images, how they look and how they sound.
type CharacterRow = { id: number; name: string; look: string; voice: string; voice_id: string | null; asset_ids: number[] }

async function characterViews(userId: number, rows: CharacterRow[]) {
  const ids = [...new Set(rows.flatMap((r) => r.asset_ids))]
  const assets = ids.length ? await db.all<{ id: number; file: string }>('SELECT id, file FROM assets WHERE id = ANY(?) AND user_id = ? AND deleted_at IS NULL', ids, userId) : []
  return rows.map((r) => ({
    id: r.id, name: r.name, look: r.look, voice: r.voice, voiceId: r.voice_id,
    images: r.asset_ids.flatMap((assetId) => {
      const asset = assets.find((a) => a.id === assetId)
      return asset ? [{ assetId, url: `/media/${asset.file}` }] : []
    }),
  }))
}

async function characterInput(userId: number, body: { name?: unknown; look?: unknown; voice?: unknown; voiceId?: unknown; assetIds?: unknown }) {
  const text = (value: unknown, max: number, label: string) => {
    if (value !== undefined && typeof value !== 'string') throw new JobError(`Enter ${label} as text`)
    const out = ((value as string | undefined) ?? '').trim()
    if (out.length > max) throw new JobError(`Keep ${label} under ${max} characters`)
    return out
  }
  const name = text(body.name, 60, 'the name')
  if (!name) throw new JobError('Give the character a name')
  const look = text(body.look, 800, 'the look')
  const voice = text(body.voice, 400, 'the voice')
  const voiceId = body.voiceId == null || body.voiceId === '' ? null : String(body.voiceId)
  if (voiceId !== null && !voicePreset(voiceId)) throw new JobError('Choose a voice from the list')
  const assetIds = body.assetIds
  if (!Array.isArray(assetIds) || assetIds.length < 1 || assetIds.length > 3 || assetIds.some((id) => !Number.isSafeInteger(id)) || new Set(assetIds).size !== assetIds.length) {
    throw new JobError('Choose 1 to 3 images of the character')
  }
  const owned = await db.all<{ id: number }>(`SELECT a.id FROM assets a JOIN jobs j ON j.id = a.job_id
    WHERE a.id = ANY(?) AND a.user_id = ? AND a.deleted_at IS NULL AND j.kind = 'image' AND j.status = 'succeeded'`, assetIds, userId)
  if (owned.length !== assetIds.length) throw new JobError('A chosen image was not found')
  // The description reaches the model with every prompt, so it passes the content policy once here.
  const spoken = voiceText(voiceId, voice)
  const check = await checkPrompt(userId, [`Character: ${name}.`, look, spoken && `Voice: ${spoken}`].filter(Boolean).join(' '))
  if (!check.allowed) {
    await recordBlocked(userId, `Character: ${name}`, check)
    throw new JobError(`This character can’t be saved: ${check.reasonEn || check.reasonAr}`)
  }
  return { name, look, voice, voiceId, assetIds: assetIds as number[] }
}

const characterRow = async (id: number) => (await db.get<CharacterRow>('SELECT id, name, look, voice, voice_id, asset_ids FROM characters WHERE id = ?', id))!

api.get('/characters', async (c) => {
  const userId = c.get('user').id
  const rows = await db.all<CharacterRow>('SELECT id, name, look, voice, voice_id, asset_ids FROM characters WHERE user_id = ? AND deleted_at IS NULL ORDER BY id', userId)
  return c.json(await characterViews(userId, rows))
})

api.post('/characters', async (c) => {
  const userId = c.get('user').id
  const input = await characterInput(userId, await c.req.json())
  const now = Date.now()
  const id = await db.insert('INSERT INTO characters (user_id, name, look, voice, voice_id, asset_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    userId, input.name, input.look, input.voice, input.voiceId, input.assetIds, now, now)
  await audit(userId, 'character.created', { characterId: id })
  return c.json((await characterViews(userId, [await characterRow(id)]))[0], 201)
})

api.patch('/characters/:id', async (c) => {
  const userId = c.get('user').id
  const id = collectionId(c.req.param('id'))
  if (!await db.get('SELECT id FROM characters WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId)) return c.json({ error: 'Character not found' }, 404)
  const input = await characterInput(userId, await c.req.json())
  await db.run('UPDATE characters SET name = ?, look = ?, voice = ?, voice_id = ?, asset_ids = ?, updated_at = ? WHERE id = ?',
    input.name, input.look, input.voice, input.voiceId, input.assetIds, Date.now(), id)
  return c.json((await characterViews(userId, [await characterRow(id)]))[0])
})

api.delete('/characters/:id', async (c) => {
  const updated = await db.run('UPDATE characters SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    Date.now(), collectionId(c.req.param('id')), c.get('user').id)
  return updated ? c.json({ ok: true }) : c.json({ error: 'Character not found' }, 404)
})

// ---------- admin ----------
const admin = new Hono<AppEnv>()
admin.use('*', requireAdmin)

async function validDepartmentId(id: unknown): Promise<boolean> {
  return id === null || (typeof id === 'number' && Number.isInteger(id) && id > 0 && id <= 2147483647 &&
    Boolean(await db.get('SELECT id FROM departments WHERE id = ?', id)))
}

admin.get('/overview', async (c) => {
  const today = ledger.startOfToday()
  const org = await ledger.orgWalletId()
  const users = await db.all<{ id: number }>(`SELECT u.id, u.name, u.email, u.role, u.disabled, u.department_id AS "departmentId", d.name AS department FROM users u LEFT JOIN departments d ON d.id = u.department_id ORDER BY u.name`)
  const jobsToday = await db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY status', today)
  const google = (await db.get<{ s: number }>("SELECT COALESCE(SUM(google_cost_usd), 0) AS s FROM jobs WHERE created_at >= ? AND status IN ('reserved','running','succeeded')", today))!
  const recent = await db.all<JobRow & { user_name: string }>(`SELECT j.*, u.name AS user_name FROM jobs j JOIN users u ON u.id = j.user_id ORDER BY j.id DESC LIMIT 25`)
  const recentViews = await jobViews(recent)
  return c.json({
    pool: await ledger.balance(org),
    spentToday: await ledger.spentSince(null, today),
    googleUsdToday: google.s,
    dailySpendCapUsd: config.dailySpendCapUsd,
    jobsToday: Object.fromEntries(jobsToday.map((r) => [r.status, r.n])),
    departments: await db.all('SELECT id, name FROM departments ORDER BY name'),
    users: await Promise.all(users.map(async (u) => {
      const w = await ledger.userWalletId(u.id)
      return { ...u, balance: await ledger.balance(w), allowance: await ledger.dailyAllowance(u.id) }
    })),
    requests: await db.all(`SELECT t.*, u.name, d.name AS department FROM topup_requests t JOIN users u ON u.id = t.user_id
      LEFT JOIN departments d ON d.id = u.department_id WHERE t.status = 'pending' ORDER BY t.id`),
    jobs: recent.map((j, i) => ({ ...recentViews[i], userName: j.user_name })),
    audit: await db.all(`SELECT a.id, a.action, a.details, a.created_at AS "createdAt", u.name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 20`),
  })
})

admin.post('/topups/:id/:decision', async (c) => {
  const me = c.get('user')
  const id = Number(c.req.param('id'))
  const decision = c.req.param('decision')
  const req = await db.get<{ user_id: number; amount: number }>("SELECT * FROM topup_requests WHERE id = ? AND status = 'pending'", id)
  if (!req) return c.json({ error: 'Request not found' }, 404)
  if (decision === 'approve') {
    const body = await c.req.json<{ amount?: number }>().catch(() => ({}) as { amount?: number })
    const amount = Math.round(body.amount ?? req.amount)
    await tx(async () => {
      // Only a still-pending request is approved, so a double click can't pay twice.
      const changed = await db.run("UPDATE topup_requests SET status = 'approved', decided_by = ?, decided_amount = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
        me.id, amount, Date.now(), id)
      if (!changed) throw new JobError('This request was already decided')
      await ledger.allocate(await ledger.orgWalletId(), await ledger.userWalletId(req.user_id), amount, me.id, `Approved request #${id}`)
      // People usually ask because they hit today's limit, so the approval also lifts it for today.
      await ledger.grantExtraToday(req.user_id, amount, me.id)
    })
    await audit(me.id, 'topup.approved', { requestId: id, userId: req.user_id, amount })
  } else {
    await db.run("UPDATE topup_requests SET status = 'denied', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", me.id, Date.now(), id)
    await audit(me.id, 'topup.denied', { requestId: id, userId: req.user_id })
  }
  return c.json({ ok: true })
})

admin.post('/allocate', async (c) => {
  const me = c.get('user')
  const { userId, amount } = await c.req.json<{ userId: number; amount: number }>()
  await tx(async () => ledger.allocate(await ledger.orgWalletId(), await ledger.userWalletId(userId), Math.round(amount), me.id, 'Manual allocation'))
  await audit(me.id, 'credits.allocated', { userId, amount })
  return c.json({ ok: true })
})

admin.post('/users', async (c) => {
  const body = await c.req.json<{
    name?: unknown
    email?: unknown
    credential?: unknown
    credentialType?: unknown
    limit?: unknown
    departmentId?: unknown
  }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid account details' }, 400)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!name || name.length > 120) return c.json({ error: 'Enter a name of up to 120 characters' }, 400)
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Enter a valid email address' }, 400)
  }

  const { credential, credentialType, limit = null, departmentId = null } = body
  if (limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 2147483647)) {
    return c.json({ error: 'Enter a positive whole number of credits, or leave the limit blank' }, 400)
  }
  if (!(await validDepartmentId(departmentId))) {
    return c.json({ error: 'Select an existing department' }, 400)
  }

  if (typeof credential !== 'string' || (credentialType !== 'password' && credentialType !== 'bcrypt')) {
    return c.json({ error: 'Enter a password or an existing bcrypt hash' }, 400)
  }
  if (credentialType === 'password' && !isValidNewPassword(credential)) {
    return c.json({ error: 'Passwords must have at least 8 characters and use at most 72 UTF-8 bytes' }, 400)
  }
  if (credentialType === 'bcrypt' && !isBcryptHash(credential.trim())) {
    return c.json({ error: 'Enter a valid bcrypt hash with cost 04 through 14' }, 400)
  }

  const passwordHash = credentialType === 'bcrypt' ? credential.trim() : await hashBcryptPassword(credential)
  const user = await tx(async () => {
    const created = await db.get<{ id: number }>(`
      INSERT INTO users (name, email, password_hash, role, department_id, daily_limit)
      VALUES (?, ?, ?, 'employee', ?, ?) ON CONFLICT (email) DO NOTHING RETURNING id
    `, name, email, passwordHash, departmentId, limit)
    if (!created) return null
    await ledger.userWalletId(created.id)
    await audit(c.get('user').id, 'user.created', { userId: created.id, limit, departmentId })
    return created
  })
  if (!user) return c.json({ error: 'An account already exists with this email address' }, 409)
  return c.json({ id: user.id }, 201)
})

admin.post('/users/:id/department', async (c) => {
  const userId = Number(c.req.param('id'))
  if (!Number.isInteger(userId) || userId < 1 || userId > 2147483647) {
    return c.json({ error: 'Invalid account ID' }, 400)
  }

  const body = await c.req.json<{ departmentId?: unknown }>().catch(() => null)
  const departmentId = body?.departmentId
  if (!(await validDepartmentId(departmentId))) {
    return c.json({ error: 'Select an existing department or No department' }, 400)
  }

  const found = await tx(async () => {
    const updated = await db.run('UPDATE users SET department_id = ? WHERE id = ?', departmentId, userId)
    if (!updated) return false
    await audit(c.get('user').id, 'user.department_changed', { userId, departmentId })
    return true
  })
  if (!found) return c.json({ error: 'Account not found' }, 404)
  return c.json({ ok: true })
})

admin.post('/users/:id/password', async (c) => {
  const userId = Number(c.req.param('id'))
  if (!Number.isInteger(userId) || userId < 1 || userId > 2147483647) {
    return c.json({ error: 'Invalid account ID' }, 400)
  }

  const body = await c.req.json<{ password?: unknown }>().catch(() => null)
  if (typeof body?.password !== 'string' || !isValidNewPassword(body.password)) {
    return c.json({ error: 'Passwords must have at least 8 characters and use at most 72 UTF-8 bytes' }, 400)
  }

  const passwordHash = await hashBcryptPassword(body.password)
  const found = await tx(async () => {
    const updated = await db.run("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'employee'", passwordHash, userId)
    if (!updated) return false
    await db.run('DELETE FROM sessions WHERE user_id = ?', userId)
    await audit(c.get('user').id, 'user.password_reset', { userId })
    return true
  })
  if (!found) return c.json({ error: 'Employee account not found' }, 404)
  return c.json({ ok: true })
})

admin.post('/users/:id/status', async (c) => {
  const userId = Number(c.req.param('id'))
  const body = await c.req.json<{ disabled?: unknown }>().catch(() => null)
  if (!Number.isInteger(userId) || userId < 1 || userId > 2147483647 || typeof body?.disabled !== 'boolean') {
    return c.json({ error: 'Invalid account status' }, 400)
  }

  const { disabled } = body
  const found = await tx(async () => {
    const user = await db.get<{ disabled: boolean }>("SELECT disabled FROM users WHERE id = ? AND role = 'employee' FOR UPDATE", userId)
    if (!user) return false
    if (user.disabled === disabled) return true

    await db.run('UPDATE users SET disabled = ? WHERE id = ?', disabled, userId)
    if (disabled) await db.run('DELETE FROM sessions WHERE user_id = ?', userId)
    await audit(c.get('user').id, disabled ? 'user.disabled' : 'user.enabled', { userId })
    return true
  })
  if (!found) return c.json({ error: 'Employee account not found' }, 404)
  return c.json({ ok: true })
})

admin.post('/users/:id/limit', async (c) => {
  const { limit } = await c.req.json<{ limit: number | null }>()
  const value = limit == null || !(limit > 0) ? null : Math.round(limit)
  await db.run('UPDATE users SET daily_limit = ? WHERE id = ?', value, Number(c.req.param('id')))
  await audit(c.get('user').id, 'limit.changed', { userId: Number(c.req.param('id')), limit: value })
  return c.json({ ok: true })
})

// Who spent what over a period: the answer to "who is using up the credits?"
admin.get('/report', async (c) => {
  const days = [1, 7, 30].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 7
  const since = days === 1 ? ledger.startOfToday() : Date.now() - days * 24 * 60 * 60 * 1000
  // $1 is reused for every "since".
  const rows = await db.all<{ credits: number; googleUsd: number; department: string | null }>(`
    SELECT u.id, u.name, d.name AS department, u.daily_limit AS "dailyLimit",
      COALESCE((SELECT -SUM(e.amount) FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id
        WHERE w.owner_type = 'user' AND w.owner_id = u.id AND e.type IN ('reserve','commit','refund') AND e.created_at >= $1), 0) AS credits,
      COALESCE((SELECT SUM(j.google_cost_usd) FROM jobs j WHERE j.user_id = u.id AND j.status = 'succeeded' AND j.created_at >= $1), 0) AS "googleUsd",
      (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.kind = 'video' AND j.model_key <> 'upload' AND j.status = 'succeeded' AND j.created_at >= $1) AS videos,
      (SELECT COUNT(*) FROM assets a JOIN jobs j ON j.id = a.job_id WHERE j.user_id = u.id AND j.kind = 'image' AND j.model_key <> 'upload' AND j.created_at >= $1) AS images,
      (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.status = 'failed' AND j.created_at >= $1) AS failed,
      (SELECT COUNT(*) FROM jobs j WHERE j.user_id = u.id AND j.status = 'blocked' AND j.created_at >= $1) AS blocked,
      (SELECT COUNT(*) FROM topup_requests t WHERE t.user_id = u.id AND t.created_at >= $1) AS requests,
      (SELECT MAX(j.created_at) FROM jobs j WHERE j.user_id = u.id) AS "lastActive"
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY credits DESC, u.name`, since)
  const total = rows.reduce((s, r) => s + r.credits, 0)
  const teams: Record<string, number> = {}
  for (const r of rows) teams[r.department ?? '—'] = (teams[r.department ?? '—'] ?? 0) + r.credits
  return c.json({ days, total, googleUsd: rows.reduce((s, r) => s + r.googleUsd, 0), people: rows, teams })
})

admin.get('/policy', async (c) => c.json({
  rules: await db.all('SELECT * FROM policy_rules ORDER BY id'),
  keywords: await db.all('SELECT * FROM blocked_keywords ORDER BY id'),
}))

admin.post('/policy/keywords', async (c) => {
  const { word } = await c.req.json<{ word: string }>()
  if (!word?.trim()) return c.json({ error: 'Empty word' }, 400)
  await db.run('INSERT INTO blocked_keywords (word) VALUES (?) ON CONFLICT (word) DO NOTHING', word.trim())
  await audit(c.get('user').id, 'policy.keyword_added', { word: word.trim() })
  return c.json({ ok: true })
})

admin.delete('/policy/keywords/:id', async (c) => {
  const row = await db.get<{ word: string }>('SELECT word FROM blocked_keywords WHERE id = ?', Number(c.req.param('id')))
  await db.run('DELETE FROM blocked_keywords WHERE id = ?', Number(c.req.param('id')))
  await audit(c.get('user').id, 'policy.keyword_removed', { word: row?.word })
  return c.json({ ok: true })
})

admin.post('/policy/rules/:id', async (c) => {
  const { active } = await c.req.json<{ active: boolean }>()
  await db.run('UPDATE policy_rules SET active = ? WHERE id = ?', active ? 1 : 0, Number(c.req.param('id')))
  await audit(c.get('user').id, active ? 'policy.rule_on' : 'policy.rule_off', { ruleId: Number(c.req.param('id')) })
  return c.json({ ok: true })
})

api.route('/admin', admin)
app.route('/api', api)

// Media is only served to signed-in users: the owner, or an admin.
app.get('/media/:file', requireUser, async (c) => {
  const user = c.get('user')
  const file = c.req.param('file').replace(/[^\w.-]/g, '')
  const bin = c.req.query('bin') === '1'
  const asset = await db.get<{ user_id: number; mime: string }>('SELECT user_id, mime FROM assets WHERE file = ? AND (deleted_at IS NOT NULL) = ?', file, bin)
  if (!asset || (asset.user_id !== user.id && (bin || user.role !== 'admin'))) return c.text('Not found', 404)
  const path = join(config.dataDir, 'media', file)
  let size: number
  try { size = statSync(path).size } catch { return c.text('Not found', 404) }
  // A file is written once and never changed, so the browser can keep it. Streaming with
  // Range support lets a video start playing and seek before the whole file arrives.
  const etag = `"${file}-${size}"`
  const headers: Record<string, string> = {
    'content-type': asset.mime,
    'cache-control': bin ? 'private, no-store' : 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
    etag,
    'x-content-type-options': 'nosniff',
  }
  if (!bin && c.req.header('if-none-match') === etag) return c.body(null, 304, headers)
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0)
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start > end || start >= size) return c.body(null, 416, { 'content-range': `bytes */${size}` })
    return c.body(fileStream(path, start, end), 206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
  }
  return c.body(fileStream(path, 0, size - 1), 200, { ...headers, 'content-length': String(size) })
})

// A still of a video (at half a second, past any fade-in), so the gallery shows clips at once
// and only loads a video when it's played. Made once, kept next to the media, cached for good.
const posterJobs = new Map<string, Promise<void>>()
app.get('/media/:file/poster', requireUser, async (c) => {
  const user = c.get('user')
  const file = c.req.param('file').replace(/[^\w.-]/g, '')
  const bin = c.req.query('bin') === '1'
  const asset = await db.get<{ user_id: number; mime: string }>('SELECT user_id, mime FROM assets WHERE file = ? AND (deleted_at IS NOT NULL) = ?', file, bin)
  if (!asset || (asset.user_id !== user.id && (bin || user.role !== 'admin')) || !asset.mime.startsWith('video')) return c.text('Not found', 404)
  const dir = join(config.dataDir, 'media', 'posters')
  const poster = join(dir, `${file}.jpg`)
  if (!existsSync(poster)) {
    let making = posterJobs.get(file)
    if (!making) {
      making = frameAt(file, 0.5).then((jpg) => {
        mkdirSync(dir, { recursive: true })
        writeFileSync(poster, jpg)
      }).finally(() => posterJobs.delete(file))
      posterJobs.set(file, making)
    }
    try { await making } catch (err) {
      console.error('[poster]', file, (err as Error).message)
      return c.text('No poster', 404)
    }
  }
  return c.body(new Uint8Array(readFileSync(poster)), 200, {
    'content-type': 'image/jpeg',
    'cache-control': bin ? 'private, no-store' : 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
})

function fileStream(path: string, start: number, end: number) {
  return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
}

const dist = resolve(import.meta.dirname, '..', 'dist')
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: './dist' }))
  app.get('*', (c) => c.html(readFileSync(join(dist, 'index.html'), 'utf8')))
}

await initDb()
await loadPricing()
const recovered = await recoverInterruptedJobs()
if (recovered) console.log(`Refunded ${recovered} job(s) interrupted by the last restart`)

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Studio API on http://localhost:${config.port} · Postgres (Neon) · ${config.mock ? 'MOCK provider (no Google calls)' : 'Vertex AI'}`)
})
