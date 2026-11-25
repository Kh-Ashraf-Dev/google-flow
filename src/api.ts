export type User = { id: number; name: string; email: string; role: 'employee' | 'admin'; department: string | null }

export type PricingRule = {
  model_key: string
  label: string
  kind: 'video' | 'image'
  credits_per_second: number | null
  credits_per_second_1080p: number | null
  credits_per_image: number | null
  google_usd_per_unit: number
  // Video models: what the model accepts (server/pricing.ts VIDEO_CAPS).
  caps?: {
    resolutions: ('360p' | '720p' | '1080p' | '4k')[]
    seconds: { min: number; max: number; step: number; maxFromSource: number }
    autoAspect: boolean
    referenceDuration?: number | 'any'
    // Takes a start and an end image; the clip is this many seconds.
    endFrameDuration?: number | { max: number }
    fullLengthOnly: ('360p' | '720p' | '1080p' | '4k')[]
    provider?: 'fal.ai'
  }
}

// Shown in the model picker, greyed out until the client agrees to them.
export type UpcomingModel = { model_key: string; label: string; kind: 'video' | 'image'; credits_per_second: number; provider: string }

export type Allowance = { limit: number | null; extra: number; spent: number; remaining: number | null }

export type Me = {
  user: User; balance: number; spentToday: number; allowance: Allowance; mock: boolean; pricing: PricingRule[]
  upcoming: UpcomingModel[]
  imageUpscale: { size: ImageUpscaleSize; credits: number }[]
}

// Image upscale: 2K or 4K, by the fast model or the Pro one (finer detail).
export type ImageUpscaleSize = '2K' | '4K' | '2K-pro' | '4K-pro'
export const upscaleLabel = (size: string) => size.startsWith('x') ? size.replace('x', '×') : size.replace('-pro', ' Pro')

export type Params = {
  modelKey: string
  aspectRatio: '16:9' | '9:16' | 'auto'
  durationSeconds?: number
  resolution?: '360p' | '720p' | '1080p' | '4k'
  count?: number
  // Set on image upscale jobs.
  upscale?: ImageUpscaleSize | 'x2' | 'x4'
  // Set on an extended clip joined onto the clip it continues: how long the new piece is.
  extendedSeconds?: number
}

export type Check = {
  checkId: number
  allowed: boolean
  needsReview: boolean
  blockedBy: 'keyword' | 'ai' | null
  keyword?: string
  reasonEn: string
  reasonAr: string
  enhancedPrompt: string
  safeAlternative: string
  sourceLanguage: 'ar' | 'en' | 'other'
  rules: { id: number; name: string; action: string }[]
}

export type Job = {
  id: number
  kind: 'video' | 'image'
  modelKey: string
  params: Required<Params>
  status: 'blocked' | 'reserved' | 'running' | 'succeeded' | 'failed'
  promptOriginal: string
  promptFinal: string | null
  estimatedCost: number
  actualCost: number | null
  error: string | null
  needsReview: boolean
  createdAt: number
  completedAt: number | null
  assets: { id: number; url: string; mime: string; mock: boolean; favorite: boolean; name: string | null }[]
  // The prompt used media or characters that Reuse prompt can bring back.
  hasInputs: boolean
  userName?: string
  // Real length in seconds for finished MP4s, otherwise the target length.
  seconds: number | null
  sourceJobId: number | null
  sceneId: number | null
  // Jobs started by one press of Generate share this id.
  batchId: number
  upscaleOptions?: { resolution: NonNullable<Params['resolution']>; credits: number }[]
}

export type Collection = { id: number; name: string }

export type Project = { id: number; name: string; createdAt: number; updatedAt: number; items: number; cover: { url: string; mime: string } | null }

export type Character = { id: number; name: string; look: string; voice: string; voiceId: string | null; images: { assetId: number; url: string }[] }
// A preset voice for characters; its sample plays from /api/voices/:id/sample.
// group 'flow': Flow's 30 Google voices by their Google names (e.g. Enceladus), with Google's description as style.
export type VoiceOption = { id: string; label: string; labelAr: string; gender: 'male' | 'female'; group: 'preset' | 'flow'; style?: string }

// What a job's prompt was made with (GET /jobs/:id/inputs).
export type PickedImage = { jobId: number; assetId: number; url: string }
export type ReuseInputs = {
  editImages: PickedImage[]
  images: { mode: 'separate' | 'references' | 'frames'; items: PickedImage[] } | null
  source: Source | null
  characterIds: number[]
  missing: number
}

// trimStart/trimEnd: the part of the clip the scene plays (trimEnd null = to the end).
export type SceneClip = { clipId: number; job: Job; trimStart: number; trimEnd: number | null }
export type Scene = { id: number; name: string; createdAt: number; updatedAt: number; clips: SceneClip[] }

// Where a new video starts from: the last frame of a clip, an image, or a clip to edit.
export type Source = { job: Job; assetId?: number; mode: 'extend' | 'animate' | 'edit' }

export const clipSeconds = (j: Job) => j.seconds ?? j.params.durationSeconds ?? 4
// A JPEG still of a video's first moment, made once on the server and kept by the browser.
export const posterUrl = (videoUrl: string) => videoUrl.replace(/^(\/media\/[^?#]+)/, '$1/poster')
export const isPlayable =(j: Job) => j.status === 'succeeded' && !!j.assets[0]

export function clock(s: number) {
  const t = Math.max(0, Math.floor(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`, res.status)
  return json as T
}

export async function uploadStudioImage(file: Blob, projectId: number, cropOf?: number): Promise<Job> {
  // The server refuses bigger bodies by closing the connection, which reads as a network error.
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError('Choose an image up to 20 MB', 413)
  const path = `/api/images/upload?project=${projectId}${cropOf === undefined ? '' : `&cropOf=${cropOf}`}`
  const res = await fetch(path, { method: 'POST', body: file })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(json.error ?? `Upload failed (${res.status})`, res.status)
  return json as Job
}

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export const fmt = (n: number) => n.toLocaleString('en-US')

export function timeAgo(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  const d = new Date(ts)
  const today = new Date()
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today ${time}`
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`
}

export const isArabic = (s: string) => /[؀-ۿ]/.test(s)
