// Videos from fal.ai (Wan 2.5 and Kling 3 Standard), next to the Vertex models. fal runs each
// request in a queue: submit, poll its status, then fetch the result and download the MP4.
// Docs: https://fal.ai/docs/documentation/model-apis/inference/queue
import { config } from './config.ts'

type Frame = { mime: string; bytes: Buffer }
type Params = { aspectRatio: string; durationSeconds: number; resolution: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const dataUri = (f: Frame) => `data:${f.mime};base64,${f.bytes.toString('base64')}`
const headers = () => ({ Authorization: `Key ${config.falKey}`, 'Content-Type': 'application/json' })

async function falFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: headers() })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { detail: text } }
  if (!res.ok) {
    const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body)
    throw Object.assign(new Error(`fal.ai ${res.status}: ${detail.slice(0, 300)}`), { status: res.status, safety: /content|safety|nsfw|policy/i.test(detail) })
  }
  return body
}

// `model` is the endpoint without its mode, e.g. fal-ai/kling-video/v3/standard. A start image
// picks image-to-video; otherwise text-to-video.
export async function generateFal(model: string, prompt: string, params: Params, startFrame?: Frame, endFrame?: Frame): Promise<Frame> {
  if (!config.falKey) throw new Error('fal.ai is not set up yet (FAL_KEY is missing)')
  const kling = model.includes('/kling-video/')
  const input: Record<string, unknown> = { prompt, duration: String(params.durationSeconds) }
  if (kling) {
    // Without audio it's the cheaper rate in pricing.ts.
    input.generate_audio = false
    if (startFrame) input.start_image_url = dataUri(startFrame)
    if (endFrame) input.end_image_url = dataUri(endFrame)
  } else {
    input.resolution = params.resolution
    // The prompt was already checked against the ministry's rules; don't let fal rewrite it.
    input.enable_prompt_expansion = false
    if (startFrame) input.image_url = dataUri(startFrame)
  }
  // With a start image the video takes the image's shape.
  if (!startFrame) input.aspect_ratio = params.aspectRatio === '9:16' ? '9:16' : '16:9'

  const endpoint = `${model}/${startFrame ? 'image-to-video' : 'text-to-video'}`
  const job = await falFetch(`https://queue.fal.run/${endpoint}`, { method: 'POST', body: JSON.stringify(input) }) as
    { status_url: string; response_url: string; cancel_url: string }
  const deadline = Date.now() + config.jobTimeoutMs
  for (;;) {
    await sleep(5000)
    const s = await falFetch(job.status_url) as { status: string; error?: string; error_type?: string }
    if (s.status === 'COMPLETED') {
      if (s.error) {
        throw Object.assign(new Error(`fal.ai: ${s.error}`), { safety: /content|safety|nsfw|policy/i.test(`${s.error_type ?? ''} ${s.error}`) })
      }
      break
    }
    if (Date.now() > deadline) {
      void fetch(job.cancel_url, { method: 'PUT', headers: headers() }).catch(() => {})
      throw new Error('fal.ai took too long')
    }
  }
  const out = await falFetch(job.response_url) as { video?: { url?: string } }
  const url = out.video?.url
  if (!url) throw new Error('fal.ai returned no video')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Downloading the fal.ai video failed (${res.status})`)
  return { mime: 'video/mp4', bytes: Buffer.from(await res.arrayBuffer()) }
}
