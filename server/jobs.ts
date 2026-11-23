import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'
import { audit, db, tx } from './db.ts'
import * as ledger from './ledger.ts'
import { appendClip, frameAt, lastFrame, modelImage, trimClip } from './media.ts'
import { voiceText } from './voices.ts'
import { keywordHit, type CheckResult } from './policy.ts'
import { estimate, IMAGE_UPSCALE_KEY, IMAGE_UPSCALE_SIZES, IMAGE_UPSCALE_USD, imageUpscaleCredits, imageUpscaleTarget, normalize, rule, upscaleOptions, videoCaps, type GenerationParams, type ImageUpscaleSize, type Resolution } from './pricing.ts'
import * as provider from './provider.ts'
import { upscaleGeminiImage, upscaleOmni } from './vertex.ts'

export type JobStatus = 'blocked' | 'reserved' | 'running' | 'succeeded' | 'failed'

export type JobRow = {
  id: number
  user_id: number
  kind: 'video' | 'image'
  model_key: string
  params: string
  prompt_original: string
  prompt_final: string | null
  estimated_cost: number
  actual_cost: number | null
  google_cost_usd: number | null
  status: JobStatus
  provider_operation: string | null
  error: string | null
  policy: string | null
  created_at: number
  completed_at: number | null
  source_job_id: number | null
  scene_id: number | null
  // Jobs made by one press of Generate share the id of the first one.
  batch_id: number | null
  project_id: number | null
  // JSON of the media and characters the prompt used (JobInputs), so Reuse prompt can bring them back.
  inputs: string | null
}

export class JobError extends Error {}

export type ProjectRow = { id: number; user_id: number; name: string; created_at: number; updated_at: number }

export async function ownProject(userId: number, value: unknown): Promise<ProjectRow> {
  const id = Number(value)
  const project = Number.isSafeInteger(id) && id > 0 && id <= 2147483647
    ? await db.get<ProjectRow>('SELECT * FROM projects WHERE id = ? AND user_id = ?', id, userId)
    : undefined
  if (!project) throw new JobError('Project not found')
  return project
}

// What a generation was made from, saved on the job.
export type JobInputs = {
  editImages?: { jobId: number; assetId: number }[]
  images?: { mode: 'separate' | 'references' | 'frames'; items: { jobId: number; assetId: number }[] }
  sourceJobId?: number
  sourceAssetId?: number
  editVideoJobId?: number
  characterIds?: number[]
}

type LoadedCharacter = { name: string; look: string; voice: string; frames: provider.StartFrame[] }

async function loadCharacters(userId: number, ids: unknown): Promise<{ ids: number[]; list: LoadedCharacter[] }> {
  if (ids === undefined || ids === null) return { ids: [], list: [] }
  if (!Array.isArray(ids) || ids.length > 3 || ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
    throw new JobError('Choose up to 3 different characters')
  }
  const rows = await db.all<{ id: number; name: string; look: string; voice: string; voice_id: string | null; asset_ids: number[] }>(
    'SELECT id, name, look, voice, voice_id, asset_ids FROM characters WHERE id = ANY(?) AND user_id = ? AND deleted_at IS NULL', ids, userId)
  if (rows.length !== ids.length) throw new JobError('A character was not found')
  const list: LoadedCharacter[] = []
  for (const id of ids as number[]) {
    const row = rows.find((r) => r.id === id)!
    // Images moved to the Bin are skipped; the description still goes in the prompt.
    const assets = await db.all<{ id: number; file: string; mime: string }>(
      'SELECT id, file, mime FROM assets WHERE id = ANY(?) AND user_id = ? AND deleted_at IS NULL', row.asset_ids, userId)
    const frames = await Promise.all(row.asset_ids.flatMap((assetId) => {
      const asset = assets.find((a) => a.id === assetId)
      return asset ? [imageForModel(asset)] : []
    }))
    list.push({ name: row.name, look: row.look, voice: voiceText(row.voice_id, row.voice), frames })
  }
  return { ids: ids as number[], list }
}

// The characters' looks (and voices, for video) added to the prompt the model gets.
function withCharacters(prompt: string, characters: LoadedCharacter[], video: boolean) {
  if (!characters.length) return prompt
  const lines = characters.map((c) => `- ${c.name}${c.look.trim() ? `: ${c.look.trim()}` : ''}`)
  let text = `${prompt}\n\nCharacters (keep each one looking exactly like their reference images):\n${lines.join('\n')}`
  // The voice gets its own audio direction: a line buried in the look was easy for the model to skip.
  const voiced = video ? characters.filter((c) => c.voice.trim()) : []
  if (voiced.length === 1 && characters.length === 1) {
    const c = voiced[0]
    text += `\n\nAudio: every spoken line is said by ${c.name} in ${c.voice.trim().replace(/\.$/, '')}. Keep exactly this voice for the whole clip.`
  } else if (voiced.length) {
    text += `\n\nAudio (each character always speaks in their own voice, the same for the whole clip):\n${voiced.map((c) => `- ${c.name} speaks in ${c.voice.trim().replace(/\.$/, '')}`).join('\n')}`
  }
  return text
}

const modelId = (key: string) => {
  const id = config.models.generation[key]
  if (!id) throw new JobError(`Unknown model ${key}`)
  return id
}

export function getJob(id: number) {
  return db.get<JobRow>('SELECT * FROM jobs WHERE id = ?', id)
}

export async function recordBlocked(userId: number, prompt: string, check: CheckResult) {
  await db.run(`INSERT INTO jobs (user_id, kind, model_key, params, prompt_original, estimated_cost, status, policy, created_at, completed_at)
    VALUES (?, 'video', '-', '{}', ?, 0, 'blocked', ?, ?, ?)`, userId, prompt, JSON.stringify(check), Date.now(), Date.now())
  await audit(userId, 'prompt.blocked', { prompt, by: check.blockedBy, keyword: check.keyword, rules: check.rules.map((r) => r.name) })
}

async function googleSpendToday(): Promise<number> {
  return (await db.get<{ s: number }>(`SELECT COALESCE(SUM(google_cost_usd), 0) AS s FROM jobs WHERE created_at >= ? AND status IN ('reserved','running','succeeded')`,
    ledger.startOfToday()))!.s
}

export type CreateJobInput = {
  checkId: number
  finalPrompt: string
  params: GenerationParams
  // Start the video from another job: the last frame of a video (extend) or an image (animate).
  sourceJobId?: number
  sourceAssetId?: number
  // Put the new clip in this scene, right after the source clip when it's there.
  sceneId?: number
  editImage?: { jobId: number; assetId: number }
  editImages?: { jobId: number; assetId: number }[]
  images?: { mode: 'separate' | 'references' | 'frames'; items: { jobId: number; assetId: number }[] }
  // Change this video with the prompt (Omni's edit task). The result has the same length.
  editVideoJobId?: number
  projectId: number
  characterIds?: number[]
}

// How many videos one press of Generate can start.
export const MAX_VIDEOS_PER_GENERATE = 4

// `file`: an extended clip's MP4, so the new piece can be joined onto it.
type Source = { jobId: number; mode: 'extend' | 'animate' | 'edit'; frame: provider.StartFrame; name?: string; file?: string }

// The clip to edit, sent whole to the model, plus its real length.
async function loadEditVideo(userId: number, jobId: number): Promise<{ source: Source; seconds: number }> {
  const job = await getJob(jobId)
  if (!job || job.user_id !== userId || job.status !== 'succeeded' || job.kind !== 'video') throw new JobError('The video to edit was not found')
  const asset = await db.get<{ file: string; mime: string }>('SELECT file, mime FROM assets WHERE job_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', jobId)
  if (!asset) throw new JobError('That video has no media')
  if (asset.mime !== 'video/mp4') {
    if (!config.mock) throw new JobError('Only real videos can be edited')
    const seconds = (JSON.parse(job.params) as GenerationParams).durationSeconds ?? 4
    return { source: { jobId, mode: 'edit', frame: { mime: asset.mime, bytes: Buffer.alloc(0) } }, seconds }
  }
  const bytes = readFileSync(join(config.dataDir, 'media', asset.file))
  if (bytes.length > 20_000_000) throw new JobError('This video is over the 20 MB limit for editing')
  const seconds = provider.mp4Seconds(bytes) ?? 0
  if (seconds < 2.95 || seconds > 15.05) throw new JobError('Only videos between 3 and 15 seconds can be edited')
  return { source: { jobId, mode: 'edit', frame: { mime: 'video/mp4', bytes } }, seconds }
}

async function loadSource(userId: number, jobId: number, assetId?: number, kind?: 'image'): Promise<Source> {
  const job = await getJob(jobId)
  if (!job || job.user_id !== userId || job.status !== 'succeeded' || (kind && job.kind !== kind)) throw new JobError('The source media was not found')
  const assets = await db.all<{ id: number; file: string; mime: string; name: string | null }>('SELECT id, file, mime, name FROM assets WHERE job_id = ? AND deleted_at IS NULL ORDER BY id', jobId)
  const asset = assetId == null ? assets[0] : assets.find((a) => a.id === assetId)
  if (!asset) throw new JobError('That clip has no media')
  if (job.kind === 'video') {
    if (asset.mime !== 'video/mp4') {
      // Mock clips are pictures, so there is no frame to take; the mock provider ignores it anyway.
      if (!config.mock) throw new JobError('Only real videos can be extended')
      return { jobId, mode: 'extend', frame: { mime: asset.mime, bytes: Buffer.alloc(0) } }
    }
    try {
      return { jobId, mode: 'extend', frame: { mime: 'image/jpeg', bytes: await lastFrame(asset.file) }, file: asset.file }
    } catch (err) {
      throw new JobError(`Couldn’t read the last frame of that clip (${(err as Error).message})`)
    }
  }
  return { jobId, mode: 'animate', frame: await imageForModel(asset), name: asset.name ?? undefined }
}

// "@Name" in the prompt reads as plain "Name" to the model, and named images it gets as references
// are listed in order, so "@Ahmed in front of @Mosque" says which image is which.
function withImageNames(prompt: string, names: (string | undefined)[]) {
  let text = prompt
  for (const name of names) if (name) text = text.split(`@${name}`).join(name)
  text = text.replace(/(^|\s)@(?=\S)/g, '$1')
  if (!names.some(Boolean)) return text
  const lines = names.map((name, index) => `- Image ${index + 1}${name ? `: ${name}` : ''}`)
  return `${text}\n\nThe reference images, in the order given:\n${lines.join('\n')}`
}

// Uploads can be up to 20 MB; anything over 5 MB goes to the model as a smaller JPEG.
async function imageForModel(asset: { file: string; mime: string }): Promise<provider.StartFrame> {
  const bytes = readFileSync(join(config.dataDir, 'media', asset.file))
  if (bytes.length <= 5 * 1024 * 1024 || config.mock) return { mime: asset.mime, bytes }
  return { mime: 'image/jpeg', bytes: await modelImage(asset.file) }
}

// Veo makes start → end clips of one length; Omni takes any length up to its maximum.
function endFrameSeconds(duration: number | { max: number }, asked?: number) {
  return typeof duration === 'number' ? duration : Math.min(asked ?? duration.max, duration.max)
}

function modelPrompt(prompt: string, source?: Source, endFrame = false) {
  if (!source || source.mode === 'edit') return prompt
  if (endFrame) return `The video starts on the first image and ends on the last image. Move naturally from one to the other. ${prompt}`
  if (source.mode === 'extend') {
    return `This image is the last frame of the previous shot. Continue the shot seamlessly from it: same people, place, style, light and camera look, with no cut. What happens next: ${prompt}`
  }
  return `Animate this image, keeping its look and composition. ${prompt}`
}

// Inserts the clip after the source clip if the scene has it, else at the end.
async function placeInScene(sceneId: number, jobId: number, sourceJobId?: number) {
  const after = sourceJobId != null
    ? (await db.get<{ p: number | null }>('SELECT MAX(position) AS p FROM scene_clips WHERE scene_id = ? AND job_id = ?', sceneId, sourceJobId))!.p
    : null
  if (after != null) {
    await db.run('UPDATE scene_clips SET position = position + 1 WHERE scene_id = ? AND position > ?', sceneId, after)
    await db.run('INSERT INTO scene_clips (scene_id, job_id, position) VALUES (?, ?, ?)', sceneId, jobId, after + 1)
  } else {
    const end = (await db.get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM scene_clips WHERE scene_id = ?', sceneId))!.p
    await db.run('INSERT INTO scene_clips (scene_id, job_id, position) VALUES (?, ?, ?)', sceneId, jobId, end + 1)
  }
  await db.run('UPDATE scenes SET updated_at = ? WHERE id = ?', Date.now(), sceneId)
}

export async function createJobs(userId: number, input: CreateJobInput) {
  if (!Number.isInteger(input.checkId)) throw new JobError('Check the prompt first')
  const check = await db.get<{ prompt: string; enhanced: string; allowed: number; result: string; created_at: number }>(
    'SELECT * FROM prompt_checks WHERE id = ? AND user_id = ?', input.checkId, userId)
  if (!check || !check.allowed) throw new JobError('This prompt has not passed the content check')
  if (Date.now() - check.created_at > 30 * 60 * 1000) throw new JobError('The check expired, please check the prompt again')
  const finalPrompt = (input.finalPrompt ?? '').trim() || check.enhanced
  const edited = await keywordHit(finalPrompt)
  if (edited) throw new JobError(`Your edit contains “${edited}”, which is on the Ministry’s blocklist`)

  const project = await ownProject(userId, input.projectId)
  const characters = await loadCharacters(userId, input.characterIds)
  const characterFrames = characters.list.flatMap((c) => c.frames)
  const images = input.images
  const referenceDuration = videoCaps(input.params.modelKey)?.referenceDuration
  // A plain text-to-video prompt with characters becomes a reference video of their images.
  const characterReferences = characterFrames.length > 0 && rule(input.params.modelKey).kind === 'video' &&
    images === undefined && input.sourceJobId == null && input.editVideoJobId == null
  if (characterReferences && referenceDuration === undefined) {
    throw new JobError('Characters need a model that takes reference images: an Omni model or Veo 3.1 Quality')
  }
  if (images !== undefined) {
    if (!images || !['separate', 'references', 'frames'].includes(images.mode) || !Array.isArray(images.items) ||
      images.items.length < (images.mode === 'frames' || (images.mode === 'references' && !characterFrames.length) ? 2 : 1) ||
      images.items.length > (images.mode === 'frames' ? 2 : images.mode === 'references' ? 3 : 1) ||
      images.items.some((item) => !item || !Number.isSafeInteger(item.jobId) || !Number.isSafeInteger(item.assetId)) ||
      new Set(images.items.map((item) => item.assetId)).size !== images.items.length ||
      input.sourceJobId != null || input.sourceAssetId != null) {
      throw new JobError('Choose distinct images for one video mode')
    }
    if (images.mode === 'frames' && !videoCaps(input.params.modelKey)?.endFrameDuration) {
      throw new JobError('A start and end frame needs a Gemini Omni model, Veo 3.1 Quality or Veo 3.1 Fast')
    }
    if (images.mode === 'references' && referenceDuration === undefined) {
      throw new JobError('Reference images require an Omni model or Veo 3.1 Quality')
    }
  }
  let edit: Awaited<ReturnType<typeof loadEditVideo>> | undefined
  if (input.editVideoJobId != null) {
    if (!Number.isSafeInteger(input.editVideoJobId) || images !== undefined || input.sourceJobId != null) throw new JobError('Choose one video to edit')
    if (!modelId(input.params.modelKey).startsWith('gemini-omni-')) throw new JobError('Video editing needs an Omni model')
    edit = await loadEditVideo(userId, input.editVideoJobId)
  }
  const params = normalize((images?.mode === 'references' || characterReferences) && typeof referenceDuration === 'number'
    ? { ...input.params, durationSeconds: referenceDuration }
    : edit ? { ...input.params, durationSeconds: Math.round(edit.seconds) }
    : images?.mode === 'frames' ? { ...input.params, durationSeconds: endFrameSeconds(videoCaps(input.params.modelKey)!.endFrameDuration!, input.params.durationSeconds) }
    : input.params,
    input.sourceJobId != null || images?.mode === 'separate' || images?.mode === 'frames')
  // The edited video keeps the input's length, so the model must allow that length.
  if (edit && params.durationSeconds !== Math.round(edit.seconds)) {
    throw new JobError(`This model edits videos up to ${params.durationSeconds} seconds; choose Omni 1.2 Flash for longer ones`)
  }
  const r = rule(params.modelKey)
  const model = modelId(params.modelKey)
  const videoCount = r.kind === 'video' ? Math.min(Math.max(Math.round(Number(input.params.count) || 1), 1), MAX_VIDEOS_PER_GENERATE) : 1
  const cost = estimate(params)
  if (input.sceneId != null) {
    const scene = await db.get('SELECT id FROM scenes WHERE id = ? AND user_id = ?', input.sceneId, userId)
    if (!scene) throw new JobError('Scene not found')
  }
  if ((input.sourceJobId != null || images) && r.kind !== 'video') throw new JobError('Only videos can use source media')

  const editInputs = input.editImages ?? (input.editImage === undefined ? [] : [input.editImage])
  if (input.editImages !== undefined || input.editImage !== undefined) {
    if (input.editImages === null || (input.editImages !== undefined && input.editImage !== undefined) ||
      r.kind !== 'image' || !Array.isArray(editInputs) || editInputs.length < 1 || editInputs.length > 3 ||
      editInputs.some((item) => !item || !Number.isSafeInteger(item.jobId) || !Number.isSafeInteger(item.assetId)) ||
      new Set(editInputs.map((item) => item.assetId)).size !== editInputs.length) {
      throw new JobError('Choose one to three distinct images')
    }
  }
  const edits = await Promise.all(editInputs.map((item) => loadSource(userId, item.jobId, item.assetId, 'image')))
  // Images take the characters' pictures as extra reference images.
  const imageSources = r.kind === 'image' ? [...edits.map((item) => item.frame), ...characterFrames] : []
  if (imageSources.length > 3) throw new JobError('The chosen images plus the characters’ images can be at most 3. Remove an image or a character.')
  const selected: Source[] = []
  for (const item of images?.items ?? []) {
    const source = await loadSource(userId, item.jobId, item.assetId, 'image')
    selected.push(source)
  }
  const references = images?.mode === 'references' ? [...selected.map((item) => item.frame), ...characterFrames]
    : characterReferences ? characterFrames : []
  if (references.length > 3) throw new JobError('A video takes at most 3 reference images, counting the characters’ images. Remove an image or a character.')
  // Names only matter where images go to the model together: edit/combine and references.
  const namedImages = r.kind === 'image' ? edits.map((item) => item.name)
    : images?.mode === 'references' ? selected.map((item) => item.name) : []
  const modelText = withCharacters(withImageNames(finalPrompt, namedImages), characters.list, r.kind === 'video')
  const inputs: JobInputs = {
    editImages: editInputs.length ? editInputs.map(({ jobId, assetId }) => ({ jobId, assetId })) : undefined,
    images: images ? { mode: images.mode, items: images.items.map(({ jobId, assetId }) => ({ jobId, assetId })) } : undefined,
    sourceJobId: input.sourceJobId ?? undefined,
    sourceAssetId: input.sourceAssetId ?? undefined,
    editVideoJobId: input.editVideoJobId ?? undefined,
    characterIds: characters.ids.length ? characters.ids : undefined,
  }
  // Frames: the first image starts the video, the second ends it.
  const endFrame = images?.mode === 'frames' ? selected[1].frame : undefined
  const baseSources = images?.mode === 'separate' ? selected
    : images?.mode === 'frames' ? [selected[0]]
    : edit ? [edit.source]
    : [input.sourceJobId != null ? await loadSource(userId, input.sourceJobId, input.sourceAssetId) : undefined]
  // "×N videos" makes N separate takes of each source.
  const sources = baseSources.flatMap((source) => Array.from({ length: videoCount }, () => source))
  if (sources.length > 2 * MAX_VIDEOS_PER_GENERATE) throw new JobError(`That would start ${sources.length} videos; the most at once is ${2 * MAX_VIDEOS_PER_GENERATE}`)
  const jobIds = await tx(async () => {
    await checkCredits(userId, cost.credits * sources.length, cost.googleUsd * sources.length)
    const ids: number[] = []
    for (const source of sources) {
      const id = await db.insert(`INSERT INTO jobs (user_id, kind, model_key, params, prompt_original, prompt_final, estimated_cost, google_cost_usd, status, policy, created_at, source_job_id, scene_id, project_id, inputs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId, r.kind, params.modelKey, JSON.stringify(params), check.prompt, finalPrompt, cost.credits, cost.googleUsd,
        r.kind === 'video' ? 'running' : 'reserved', check.result, Date.now(), source?.jobId ?? edits[0]?.jobId ?? null, input.sceneId ?? null,
        project.id, JSON.stringify(inputs))
      await ledger.reserve(userId, id, cost.credits)
      if (input.sceneId != null) await placeInScene(input.sceneId, id, source?.jobId)
      await audit(userId, 'job.created', {
        jobId: id, model: r.label, credits: cost.credits,
        from: source ? { job: source.jobId, mode: source.mode } : undefined,
        editAssetIds: editInputs.length ? editInputs.map((item) => item.assetId) : undefined,
        referenceAssetIds: references.length ? images?.items.map((item) => item.assetId) : undefined,
      })
      ids.push(id)
    }
    await db.run('UPDATE jobs SET batch_id = ? WHERE id = ANY(?)', ids[0], ids)
    return ids
  })

  if (r.kind === 'video') {
    for (const [index, id] of jobIds.entries()) {
      const source = sources[index]
      const video = source?.mode === 'edit' ? source.frame : undefined
      // Outside a scene, an extension is joined onto the clip it continues, so the result is one
      // longer video (like Flow). In a scene the pieces stay apart, next to each other on the timeline.
      const joinOnto = source?.mode === 'extend' && input.sceneId == null ? source.file : undefined
      void runVideo(id, model, modelPrompt(modelText, source, !!endFrame), params, video ? undefined : source?.frame, references, video, endFrame, joinOnto)
    }
    return Promise.all(jobIds.map(async (id) => (await getJob(id))!))
  }
  const [jobId] = jobIds
  const guidance = edits.length > 1 ? 'Use the supplied reference images in the order shown to create a single image. Follow the prompt for how to combine them.'
    : edits.length === 1 ? 'Edit the provided image. Preserve details outside the requested change.'
    : characterFrames.length ? 'The supplied images show the characters named below. Create a new image that follows the prompt.' : ''
  // Images run in the background like videos, so the studio can start the next prompt at once;
  // the page polls the job until it's done.
  await db.run("UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'reserved'", jobId)
  void (async () => {
    try {
      const images = await provider.generateImages(model, guidance ? `${guidance} ${modelText}` : modelText, params, imageSources)
      await succeed(jobId, images.map((img) => ({ ...img, mock: config.mock })), Math.ceil((r.credits_per_image ?? 1) * images.length), r.google_usd_per_unit * images.length)
    } catch (err) {
      await fail(jobId, err instanceof Error ? err.message : String(err), !!(err as { safety?: boolean })?.safety).catch((e) => console.error('[jobs] fail()', e))
    }
  })()
  return [(await getJob(jobId))!]
}

async function checkCredits(userId: number, credits: number, googleUsd: number) {
  await ledger.lockWallet(await ledger.userWalletId(userId))
  const allowance = await ledger.dailyAllowance(userId)
  if (allowance.remaining != null && credits > allowance.remaining) {
    throw new JobError(`This needs ${credits} credits but you have ${allowance.remaining} left today.`)
  }
  await db.get('SELECT pg_advisory_xact_lock(8787, 1)')
  if ((await googleSpendToday()) + googleUsd > config.dailySpendCapUsd) {
    throw new JobError(`The platform hit today’s Google spend cap ($${config.dailySpendCapUsd}). Try again tomorrow or raise the cap.`)
  }
}

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export async function uploadImage(userId: number, bytes: Buffer, cropOf: number | undefined, projectId: unknown) {
  const project = await ownProject(userId, projectId)
  if (bytes.length > MAX_IMAGE_BYTES) throw new JobError('Choose an image up to 20 MB')
  let mime: string
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) mime = 'image/png'
  else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg'
  else if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp'
  else throw new JobError('Choose a PNG, JPEG, or WebP image')
  let sourceJobId: number | null = null
  if (cropOf !== undefined) {
    if (!Number.isSafeInteger(cropOf) || cropOf < 1 || cropOf > 2147483647) throw new JobError('Choose an image to crop')
    const asset = await db.get<{ job_id: number }>(`SELECT a.job_id FROM assets a JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ? AND a.user_id = ? AND a.deleted_at IS NULL AND j.kind = 'image' AND j.status = 'succeeded'`, cropOf, userId)
    if (!asset) throw new JobError('The original image was not found')
    sourceJobId = asset.job_id
  }
  return tx(async () => {
    const now = Date.now()
    const params = JSON.stringify({ modelKey: 'upload', count: 1 })
    const id = await db.insert(`INSERT INTO jobs (user_id, kind, model_key, params, prompt_original, estimated_cost, actual_cost, google_cost_usd, status, created_at, completed_at, source_job_id, project_id)
      VALUES (?, 'image', 'upload', ?, ?, 0, 0, 0, 'succeeded', ?, ?, ?, ?)`, userId, params,
      cropOf === undefined ? 'Uploaded image' : 'Cropped image', now, now, sourceJobId, project.id)
    const job = (await getJob(id))!
    await saveAsset(job, 0, { mime, bytes })
    return job
  })
}

// Saves the frame at `seconds` as a new image in the library, like Flow's "Save frame".
export async function saveFrame(userId: number, videoJobId: number, seconds: number) {
  if (!Number.isSafeInteger(videoJobId) || !Number.isFinite(seconds) || seconds < 0) throw new JobError('Choose a point in the video')
  const job = await getJob(videoJobId)
  if (!job || job.user_id !== userId || job.kind !== 'video' || job.status !== 'succeeded') throw new JobError('The video was not found')
  const asset = await db.get<{ file: string; mime: string }>('SELECT file, mime FROM assets WHERE job_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', videoJobId)
  if (!asset) throw new JobError('That video has no media')
  if (asset.mime !== 'video/mp4') throw new JobError('Mock clips are pictures, so there is no frame to save. This works with real videos.')
  const length = provider.mp4Seconds(readFileSync(join(config.dataDir, 'media', asset.file))) ?? seconds
  // ffmpeg returns nothing past the last frame, so stay just inside the clip.
  const at = Math.min(seconds, Math.max(length - 0.05, 0))
  let bytes: Buffer
  try {
    bytes = await frameAt(asset.file, at)
  } catch (err) {
    throw new JobError(`Couldn’t read that frame (${(err as Error).message})`)
  }
  const minutes = Math.floor(at / 60)
  const label = `Frame at ${minutes}:${(at - minutes * 60).toFixed(1).padStart(4, '0')}`
  return tx(async () => {
    const now = Date.now()
    const id = await db.insert(`INSERT INTO jobs (user_id, kind, model_key, params, prompt_original, estimated_cost, actual_cost, google_cost_usd, status, created_at, completed_at, source_job_id, project_id)
      VALUES (?, 'image', 'upload', ?, ?, 0, 0, 0, 'succeeded', ?, ?, ?, ?)`, userId, JSON.stringify({ modelKey: 'upload', count: 1 }),
      `${label} · ${job.prompt_original}`.slice(0, 500), now, now, videoJobId, job.project_id)
    const created = (await getJob(id))!
    await saveAsset(created, 0, { mime: 'image/jpeg', bytes })
    await audit(userId, 'frame.saved', { jobId: id, from: videoJobId, seconds: at })
    return created
  })
}

// Saves the part of a clip between `start` and `end` as a new video in the gallery (the original
// stays), like trimming a clip in Flow. Free: it's cut locally, no model is called.
export async function trimVideo(userId: number, videoJobId: number, start: number, end: number) {
  if (!Number.isSafeInteger(videoJobId) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new JobError('Choose where the clip starts and ends')
  }
  const job = await getJob(videoJobId)
  if (!job || job.user_id !== userId || job.kind !== 'video' || job.status !== 'succeeded') throw new JobError('The video was not found')
  const asset = await db.get<{ file: string; mime: string }>('SELECT file, mime FROM assets WHERE job_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', videoJobId)
  if (!asset) throw new JobError('That video has no media')
  if (asset.mime !== 'video/mp4') throw new JobError('Mock clips are pictures, so there is nothing to trim. This works with real videos.')
  const length = provider.mp4Seconds(readFileSync(join(config.dataDir, 'media', asset.file))) ?? end
  const from = Math.min(start, Math.max(length - 0.5, 0))
  const to = Math.min(end, length)
  if (to - from < 0.5) throw new JobError('Keep at least half a second of the clip')
  let bytes: Buffer
  try {
    bytes = await trimClip(asset.file, from, to)
  } catch (err) {
    throw new JobError(`Couldn’t trim the clip (${(err as Error).message})`)
  }
  const original = JSON.parse(job.params) as GenerationParams
  const seconds = provider.mp4Seconds(bytes) ?? to - from
  const params = { ...original, modelKey: 'upload', durationSeconds: Math.round(seconds * 10) / 10, count: 1 }
  const label = `Trimmed ${from.toFixed(1)}–${to.toFixed(1)}s`
  return tx(async () => {
    const now = Date.now()
    const id = await db.insert(`INSERT INTO jobs (user_id, kind, model_key, params, prompt_original, prompt_final, estimated_cost, actual_cost, google_cost_usd, status, policy, created_at, completed_at, source_job_id, project_id)
      VALUES (?, 'video', 'upload', ?, ?, ?, 0, 0, 0, 'succeeded', ?, ?, ?, ?, ?)`, userId, JSON.stringify(params),
      `${label} · ${job.prompt_original}`.slice(0, 500), job.prompt_final, job.policy, now, now, videoJobId, job.project_id)
    const created = (await getJob(id))!
    await saveAsset(created, 0, { mime: 'video/mp4', bytes })
    await audit(userId, 'video.trimmed', { jobId: id, from: videoJobId, start: from, end: to })
    return created
  })
}

export async function upscaleVideo(userId: number, sourceId: number, resolution: Resolution) {
  if (!Number.isSafeInteger(sourceId)) throw new JobError('Choose a video to upscale')
  const source = await getJob(sourceId)
  if (!source || source.user_id !== userId || source.kind !== 'video' || source.status !== 'succeeded') {
    throw new JobError('The source video was not found')
  }
  const asset = await db.get<{ file: string }>("SELECT file FROM assets WHERE job_id = ? AND deleted_at IS NULL AND mime = 'video/mp4' ORDER BY id LIMIT 1", sourceId)
  if (!asset) throw new JobError('Only finished MP4 videos can be upscaled')
  const bytes = readFileSync(join(config.dataDir, 'media', asset.file))
  if (bytes.length > 20_000_000) throw new JobError('The source video exceeds the 20 MB inline limit')
  const original = JSON.parse(source.params) as Required<GenerationParams>
  const durationSeconds = provider.mp4Seconds(bytes) ?? 0
  const cost = upscaleOptions(original.resolution, durationSeconds).find((option) => option.resolution === resolution)
  if (!cost) throw new JobError('That upscale resolution is unavailable for this clip')
  const params = { ...original, modelKey: 'omni-flash-1.2', resolution, durationSeconds, count: 1 }
  const jobId = await tx(async () => {
    await checkCredits(userId, cost.credits, cost.googleUsd)
    const id = await db.insert(`INSERT INTO jobs (user_id, kind, model_key, params, prompt_original, prompt_final, estimated_cost, google_cost_usd, status, policy, created_at, source_job_id, project_id)
      VALUES (?, 'video', ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      userId, params.modelKey, JSON.stringify(params), source.prompt_original, source.prompt_final, cost.credits, cost.googleUsd, source.policy, Date.now(), sourceId, source.project_id)
    await ledger.reserve(userId, id, cost.credits)
    await audit(userId, 'job.upscale', { jobId: id, sourceId, resolution })
    return id
  })
  void finishUpscale(jobId, bytes, resolution)
  return (await getJob(jobId))!
}

// Image upscale: a new copy of one image at 2K or 4K, by the fast or the Pro model. It runs in
// the background like a generation; the page polls the new job.
export async function upscaleImage(userId: number, assetId: number, size: ImageUpscaleSize) {
  if (!Number.isSafeInteger(assetId) || !IMAGE_UPSCALE_SIZES.includes(size)) throw new JobError('Choose an image and an upscale size')
  const asset = await db.get<{ job_id: number; file: string; mime: string }>(`SELECT a.job_id, a.file, a.mime FROM assets a JOIN jobs j ON j.id = a.job_id
    WHERE a.id = ? AND a.user_id = ? AND a.deleted_at IS NULL AND j.kind = 'image' AND j.status = 'succeeded'`, assetId, userId)
  if (!asset) throw new JobError('The image was not found')
  if (!config.mock && !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mime)) throw new JobError('Only PNG, JPEG or WebP images can be upscaled')
  const source = (await getJob(asset.job_id))!
  const credits = imageUpscaleCredits(size)
  const usd = IMAGE_UPSCALE_USD[size]
  const original = JSON.parse(source.params) as GenerationParams
  const params = { modelKey: IMAGE_UPSCALE_KEY, aspectRatio: original.aspectRatio ?? '16:9', count: 1, upscale: size }
  const jobId = await tx(async () => {
    await checkCredits(userId, credits, usd)
    const id = await db.insert(`INSERT INTO jobs (user_id, kind, model_key, params, prompt_original, prompt_final, estimated_cost, google_cost_usd, status, policy, created_at, source_job_id, project_id, inputs)
      VALUES (?, 'image', ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      userId, IMAGE_UPSCALE_KEY, JSON.stringify(params), source.prompt_original, source.prompt_final, credits, usd,
      source.policy, Date.now(), source.id, source.project_id, null)
    await ledger.reserve(userId, id, credits)
    await audit(userId, 'job.image_upscale', { jobId: id, assetId, size })
    return id
  })
  const target = imageUpscaleTarget(size)
  const model = target.pro ? config.models.generation['nano-banana-pro'] : config.models.imageUpscale
  void (async () => {
    try {
      const file = config.mock
        ? { mime: asset.mime, bytes: readFileSync(join(config.dataDir, 'media', asset.file)) }
        : await upscaleGeminiImage(model, await imageForModel(asset), target.size)
      await succeed(jobId, [{ ...file, mock: config.mock }])
    } catch (err) {
      await fail(jobId, err instanceof Error ? err.message : String(err), !!(err as { safety?: boolean })?.safety).catch((e) => console.error('[jobs] fail()', e))
    }
  })()
  return (await getJob(jobId))!
}

async function finishUpscale(jobId: number, bytes: Buffer, resolution: Resolution) {
  try {
    const file = config.mock ? { mime: 'video/mp4', bytes } : await upscaleOmni(modelId('omni-flash-1.2'), bytes, resolution)
    await succeed(jobId, [{ ...file, mock: config.mock }])
  } catch (err) {
    await fail(jobId, (err as Error).message, false).catch((error) => console.error('[jobs] fail()', error))
  }
}

async function saveAsset(job: JobRow, i: number, file: { mime: string; bytes: Buffer; mock?: boolean }) {
  const ext = file.mime.includes('svg') ? 'svg' : file.mime.includes('mp4') ? 'mp4' : file.mime.includes('jpeg') ? 'jpg' : file.mime === 'image/webp' ? 'webp' : 'png'
  const name = `${job.id}-${i}.${ext}`
  writeFileSync(join(config.dataDir, 'media', name), file.bytes)
  await db.run('INSERT INTO assets (job_id, user_id, file, mime, mock, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    job.id, job.user_id, name, file.mime, file.mock ? 1 : 0, Date.now())
}

async function succeed(jobId: number, files: { mime: string; bytes: Buffer; mock?: boolean }[], actual?: number, googleUsd?: number) {
  await tx(async () => {
    // FOR UPDATE: a timeout refund and a late success can't both settle the same job.
    const job = (await db.get<JobRow>('SELECT * FROM jobs WHERE id = ? FOR UPDATE', jobId))!
    if (job.status !== 'reserved' && job.status !== 'running') return // already timed out and refunded
    const finalCost = actual ?? job.estimated_cost
    for (const [i, f] of files.entries()) await saveAsset(job, i, f)
    await ledger.commit(job.user_id, jobId, job.estimated_cost, finalCost)
    await db.run("UPDATE jobs SET status = 'succeeded', actual_cost = ?, google_cost_usd = COALESCE(?, google_cost_usd), completed_at = ? WHERE id = ?",
      finalCost, googleUsd ?? null, Date.now(), jobId)
  })
}

async function runVideo(jobId: number, model: string, prompt: string, params: Required<GenerationParams>, frame: provider.StartFrame | undefined, references: provider.StartFrame[], video?: provider.StartFrame, endFrame?: provider.StartFrame, joinOnto?: string) {
  try {
    const file = await provider.generateVideo(model, prompt, params, frame, references, video, endFrame)
    // Bill the length Google actually made, not the one asked for.
    const seconds = file.mime === 'video/mp4' ? provider.mp4Seconds(file.bytes) : null
    if (seconds) {
      const real = estimate({ ...params, durationSeconds: seconds })
      const joined = joinOnto ? await joinExtension(jobId, joinOnto, file.bytes, params, seconds) : null
      await succeed(jobId, [joined ?? file], real.credits, real.googleUsd)
    } else {
      await succeed(jobId, [{ ...file, mock: config.mock }])
    }
  } catch (err) {
    await fail(jobId, err instanceof Error ? err.message : String(err), !!(err as { safety?: boolean })?.safety).catch((e) => console.error('[jobs] fail()', e))
  }
}

// The clip it extends followed by the new piece, as one MP4. The job's params remember how long
// the new piece is (`extendedSeconds`), so the card can say "8s + 4s". If joining fails, the
// new piece is kept on its own rather than failing a paid video.
async function joinExtension(jobId: number, sourceFile: string, piece: Buffer, params: Required<GenerationParams>, seconds: number) {
  try {
    const bytes = await appendClip(sourceFile, piece, params.aspectRatio, params.resolution)
    await db.run('UPDATE jobs SET params = ? WHERE id = ?', JSON.stringify({ ...params, extendedSeconds: Math.round(seconds * 10) / 10 }), jobId)
    return { mime: 'video/mp4', bytes }
  } catch (err) {
    console.error('[jobs] joining the extension failed; keeping the new piece alone', (err as Error).message)
    return null
  }
}

// A restart loses in-flight requests, so their reserved credits go back.
export async function recoverInterruptedJobs() {
  const stuck = await db.all<{ id: number }>("SELECT id FROM jobs WHERE status IN ('reserved','running')")
  for (const { id } of stuck) await fail(id, 'Interrupted by a server restart', false)
  return stuck.length
}

async function fail(jobId: number, reason: string, safety: boolean) {
  const job = await tx(async () => {
    const job = (await db.get<JobRow>('SELECT * FROM jobs WHERE id = ? FOR UPDATE', jobId))!
    if (job.status !== 'reserved' && job.status !== 'running') return null
    await ledger.refund(job.user_id, jobId, job.estimated_cost, safety ? 'Stopped by Google safety filter' : 'Generation failed')
    await db.run("UPDATE jobs SET status = 'failed', actual_cost = 0, google_cost_usd = 0, error = ?, completed_at = ? WHERE id = ?",
      safety ? `safety: ${reason}` : reason, Date.now(), jobId)
    return job
  })
  if (job) await audit(job.user_id, 'job.refunded', { jobId, credits: job.estimated_cost, reason })
}

// The studio page polls this. Videos finish in the background; this only catches jobs that
// ran too long.
export async function advanceJob(jobId: number): Promise<JobRow> {
  const job = (await getJob(jobId))!
  if (job.status === 'running' && Date.now() - job.created_at > config.jobTimeoutMs) {
    await fail(jobId, 'Timed out after 10 minutes', false)
  }
  return (await getJob(jobId))!
}
