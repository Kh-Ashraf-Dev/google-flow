// Veo 3.1 on Vertex AI. The Gemini API shut Veo down on 2026-10-22; Vertex keeps the GA
// models. Auth is a service account: a signed JWT is swapped for a one-hour access token.
import { createSign } from 'node:crypto'
import { config } from './config.ts'

type ServiceAccount = { client_email: string; private_key: string; project_id: string }

let account: ServiceAccount | null = null
function serviceAccount(): ServiceAccount {
  if (account) return account
  const raw = config.vertex.keyJson.trim()
  if (!raw) throw new Error('Veo needs a Vertex AI service account. Set VERTEX_KEY_FILE (local) or VERTEX_KEY_JSON (server).')
  account = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as ServiceAccount
  return account
}

let token: { value: string; expires: number } | null = null
async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value
  const sa = serviceAccount()
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  })
  const json = (await res.json()) as { access_token: string; expires_in: number; error?: string; error_description?: string }
  if (!res.ok) throw new Error(`Vertex sign-in failed: ${json.error_description ?? json.error ?? res.status}`)
  token = { value: json.access_token, expires: Date.now() + json.expires_in * 1000 }
  return token.value
}

async function post(url: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `Vertex returned ${res.status}`), { status: res.status })
  return json
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function modelEndpoint(model: string, location: string) {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`
  return `https://${host}/v1/projects/${serviceAccount().project_id}/locations/${location}/publishers/google/models/${model}`
}

export async function generateContent(model: string, body: unknown): Promise<any> {
  const url = `${modelEndpoint(model, 'global')}:generateContent`
  for (let attempt = 0; ; attempt++) {
    try {
      return await post(url, body)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (attempt >= 2 || (status !== 429 && status !== 503)) throw err
      await sleep(attempt === 0 ? 1500 : 4000)
    }
  }
}

type Image = { mime: string; bytes: Buffer }
const inlineImage = (image: Image) => ({ bytesBase64Encoded: image.bytes.toString('base64'), mimeType: image.mime })

export type VeoParams = { aspectRatio: string; durationSeconds: number; resolution: string }

type OmniContent = { type?: string; mime_type?: string; data?: string }

export async function generateOmni(model: string, prompt: string, params: VeoParams, startFrame?: Image, references: Image[] = [], video?: Image, endFrame?: Image) {
  if (video) {
    // Edit: the output keeps the input's length, so no duration is sent.
    return omniVideo({
      model,
      store: false,
      input: [{ type: 'text', text: prompt }, { type: 'video', mime_type: video.mime, data: video.bytes.toString('base64') }],
      response_format: [{ type: 'video', delivery: 'inline', resolution: params.resolution }],
      generation_config: { video_config: { task: 'edit' } },
    })
  }
  const task = startFrame ? 'image_to_video' : references.length ? 'reference_to_video' : 'text_to_video'
  const text = references.length ? `${prompt} Use the provided images as references for the video.` : prompt
  // Start and end: the two images in order, and no task (Google's first-and-last-frame example
  // sets none; the prompt says which image starts and which ends).
  const images = startFrame && endFrame ? [startFrame, endFrame] : startFrame ? [startFrame] : references
  return omniVideo({
    model,
    store: false,
    input: [{ type: 'text', text },
      ...images.map((image) => ({ type: 'image', mime_type: image.mime, data: image.bytes.toString('base64') })),
    ],
    response_format: [{
      type: 'video', delivery: 'inline', resolution: params.resolution, duration: `${params.durationSeconds}s`,
      ...(params.aspectRatio === 'auto' ? {} : { aspect_ratio: params.aspectRatio }),
    }],
    ...(endFrame ? {} : { generation_config: { video_config: { task } } }),
  })
}

export function upscaleOmni(model: string, bytes: Buffer, resolution: string) {
  return omniVideo({
    model,
    store: false,
    input: [{ type: 'video', mime_type: 'video/mp4', data: bytes.toString('base64') }],
    response_format: [{ type: 'video', delivery: 'inline', resolution }],
    generation_config: { video_config: { task: 'upscale' } },
  })
}

// Upscale: a Gemini image model redraws the same image at a bigger size (2K or 4K).
export async function upscaleGeminiImage(model: string, image: Image, size: '2K' | '4K') {
  const out = await generateContent(model, {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') } },
      { text: 'Upscale this image to a higher resolution. Keep it identical: the same composition, people, faces, colors, light and any text. Only add sharpness and fine detail.' },
    ] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: size } },
  })
  const part = out?.candidates?.[0]?.content?.parts?.find((x: { inlineData?: { data: string } }) => x.inlineData?.data)
  if (!part) throw Object.assign(new Error('Google’s safety filter returned no image'), { safety: true })
  return { mime: part.inlineData.mimeType ?? 'image/png', bytes: Buffer.from(part.inlineData.data, 'base64') }
}

async function omniVideo(body: unknown) {
  const url = `https://aiplatform.googleapis.com/v1beta1/projects/${serviceAccount().project_id}/locations/global/interactions`
  const result = await post(url, body, AbortSignal.timeout(config.jobTimeoutMs))
  const steps: { type: string; content?: OmniContent[] }[] = result.steps ?? []
  for (const step of steps) {
    if (step.type !== 'model_output') continue
    const video = step.content?.find((item) => item.type === 'video' && item.mime_type === 'video/mp4' && item.data)
    if (video?.data) return { mime: 'video/mp4', bytes: Buffer.from(video.data, 'base64') }
  }
  throw new Error(result.error?.message ?? 'Vertex Omni returned no video')
}

// Starts a Veo job, then polls until the video is ready. Without storageUri, Vertex returns
// the video bytes in the response.
export async function generateVeo(model: string, prompt: string, p: VeoParams, startFrame?: Image, references: Image[] = [], endFrame?: Image) {
  const base = modelEndpoint(model, config.vertex.location)
  const op = await post(`${base}:predictLongRunning`, {
    instances: [{
      prompt,
      ...(startFrame ? { image: inlineImage(startFrame) } : {}),
      ...(endFrame ? { lastFrame: inlineImage(endFrame) } : {}),
      ...(references.length ? { referenceImages: references.map((image) => ({ image: inlineImage(image), referenceType: 'asset' })) } : {}),
    }],
    parameters: {
      sampleCount: 1,
      durationSeconds: p.durationSeconds,
      resolution: p.resolution,
      ...(p.aspectRatio === 'auto' ? {} : { aspectRatio: p.aspectRatio }),
      generateAudio: true,
      // allow_all lets scenes with children through: with allow_adult, Veo refused every start
      // image that showed a child (tested 2026-11-25). VEO_PERSON_GENERATION=allow_adult undoes it.
      personGeneration: process.env.VEO_PERSON_GENERATION ?? 'allow_all',
      ...(startFrame ? { resizeMode: 'crop' } : {}),
    },
  })
  const deadline = Date.now() + config.jobTimeoutMs
  while (Date.now() < deadline) {
    // Checking is free, and a shorter wait shows a finished video sooner.
    await sleep(4_000)
    const done = await post(`${base}:fetchPredictOperation`, { operationName: op.name })
    if (!done.done) continue
    if (done.error) throw new Error(done.error.message ?? 'Veo failed')
    const video = done.response?.videos?.[0]
    if (video?.bytesBase64Encoded) return { mime: video.mimeType ?? 'video/mp4', bytes: Buffer.from(video.bytesBase64Encoded, 'base64') }
    const filtered = done.response?.raiMediaFilteredCount
    console.log('[veo] no video', JSON.stringify(done.response ?? null).slice(0, 1000))
    throw Object.assign(new Error(filtered ? `Google’s safety filter stopped this video${done.response?.raiMediaFilteredReasons ? ` (${done.response.raiMediaFilteredReasons.join('; ')})` : ''}` : 'Veo returned no video'), { safety: !!filtered })
  }
  throw new Error('Veo took too long')
}
