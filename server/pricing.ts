import { db } from './db.ts'

export type Resolution = '360p' | '720p' | '1080p' | '4k'

// Veo supports 4, 6 or 8 seconds, with model-specific resolution limits.
export type VideoCaps = {
  resolutions: Resolution[]
  seconds: { min: number; max: number; step: number; maxFromSource: number }
  autoAspect: boolean
  referenceDuration?: number | 'any'
  // Takes a start and an end image (Flow's Frames to video): a fixed length (Veo), or any
  // length up to a maximum (Omni).
  endFrameDuration?: number | { max: number }
  // Resolutions that only come in the longest length (Veo: 1080p and 4K are 8 s).
  fullLengthOnly: Resolution[]
}

const VEO_SECONDS = { min: 4, max: 8, step: 2, maxFromSource: 8 }

const VIDEO_CAPS: Record<string, VideoCaps> = {
  'omni-flash-1.2': {
    resolutions: ['360p', '720p', '1080p', '4k'],
    seconds: { min: 3, max: 15, step: 1, maxFromSource: 15 },
    autoAspect: true, fullLengthOnly: [], referenceDuration: 'any',
    // Google's docs: first and last frame videos are 3 to 10 seconds.
    endFrameDuration: { max: 10 },
  },
  'omni-flash': {
    resolutions: ['360p', '720p', '1080p', '4k'],
    seconds: { min: 3, max: 10, step: 1, maxFromSource: 10 },
    autoAspect: true, fullLengthOnly: [], referenceDuration: 'any',
    // Not in Google's docs, but tested on Vertex (2026-11-18): the video starts on the first
    // image and ends on the second, like 1.2.
    endFrameDuration: { max: 10 },
  },
  'veo-3.1': { resolutions: ['720p', '1080p', '4k'], seconds: VEO_SECONDS, autoAspect: false, fullLengthOnly: ['1080p', '4k'], referenceDuration: 8, endFrameDuration: 8 },
  'veo-3.1-fast': { resolutions: ['720p', '1080p'], seconds: VEO_SECONDS, autoAspect: false, fullLengthOnly: ['1080p'], endFrameDuration: 8 },
  'veo-3.1-lite': { resolutions: ['720p', '1080p'], seconds: VEO_SECONDS, autoAspect: false, fullLengthOnly: ['1080p'] },
}

export const videoCaps = (modelKey: string) => VIDEO_CAPS[modelKey]

// 1 credit = $0.08. Credits per second are Google's price ÷ $0.08, rounded up to a whole
// credit at 720p and 1080p. The USD rates are used for the daily spend cap.
const VIDEO_RATES: Record<string, Partial<Record<Resolution, { usd: number; credits: number }>>> = {
  'omni-flash-1.2': {
    '360p': { usd: 0.0232, credits: 0.34 }, '720p': { usd: 0.07, credits: 1 },
    '1080p': { usd: 0.1043, credits: 2 }, '4k': { usd: 0.2086, credits: 4 },
  },
  'omni-flash': {
    '360p': { usd: 0.0337925, credits: 0.68 }, '720p': { usd: 0.10136, credits: 2 },
    '1080p': { usd: 0.15204, credits: 2 }, '4k': { usd: 0.30408, credits: 4 },
  },
  'veo-3.1-lite': { '720p': { usd: 0.05, credits: 1 }, '1080p': { usd: 0.08, credits: 1 } },
  'veo-3.1-fast': { '720p': { usd: 0.1, credits: 2 }, '1080p': { usd: 0.12, credits: 2 } },
  'veo-3.1': { '720p': { usd: 0.4, credits: 5 }, '1080p': { usd: 0.4, credits: 5 }, '4k': { usd: 0.6, credits: 8 } },
}

// The 720p row, shown in the model picker and stored in pricing_rules.
export const videoRate720 = (modelKey: string) => VIDEO_RATES[modelKey]?.['720p']

export type PricingRule = {
  model_key: string
  label: string
  kind: 'video' | 'image'
  credits_per_second: number | null
  credits_per_second_1080p: number | null
  credits_per_image: number | null
  google_usd_per_unit: number
  caps?: VideoCaps
}

export type GenerationParams = {
  modelKey: string
  // 'auto' (Omni only) sends no aspect ratio and lets the model choose.
  aspectRatio: '16:9' | '9:16' | 'auto'
  durationSeconds?: number
  resolution?: Resolution
  count?: number
}

// Prices only change at startup (syncPricing in db.ts), so they're read once and kept here.
let rules: PricingRule[] = []

export async function loadPricing() {
  const rows = await db.all<PricingRule>('SELECT * FROM pricing_rules ORDER BY kind DESC, google_usd_per_unit')
  rules = rows.map((r) => (r.kind === 'video' && VIDEO_CAPS[r.model_key] ? { ...r, caps: VIDEO_CAPS[r.model_key] } : r))
}

export function pricingRules(): PricingRule[] {
  return rules
}

export function rule(modelKey: string): PricingRule {
  const r = rules.find((x) => x.model_key === modelKey)
  if (!r) throw new Error(`Unknown model ${modelKey}`)
  return r
}

export function normalize(p: GenerationParams, fromSource = false): Required<GenerationParams> {
  const r = rule(p.modelKey)
  const count = r.kind === 'video' ? 1 : Math.min(Math.max(Math.round(p.count ?? 1), 1), 4)
  if (r.kind === 'image') {
    return { modelKey: p.modelKey, aspectRatio: p.aspectRatio === '9:16' ? '9:16' : '16:9', durationSeconds: 0, resolution: '720p', count }
  }
  const caps = VIDEO_CAPS[p.modelKey]
  const resolution: Resolution = p.resolution && caps.resolutions.includes(p.resolution) ? p.resolution
    : p.resolution === '4k' && caps.resolutions.includes('1080p') ? '1080p' : '720p'
  const { min, step } = caps.seconds
  const max = fromSource ? caps.seconds.maxFromSource : caps.seconds.max
  // Snap to the model's steps (Veo: 4, 6, 8) inside its range.
  let seconds = Math.round(((Number(p.durationSeconds) || max) - min) / step) * step + min
  seconds = Math.min(Math.max(seconds, min), max)
  if (caps.fullLengthOnly.includes(resolution)) seconds = max
  return {
    modelKey: p.modelKey,
    aspectRatio: p.aspectRatio === '9:16' ? '9:16' : p.aspectRatio === 'auto' && caps.autoAspect ? 'auto' : '16:9',
    // Sent as the model's duration; the real length is billed afterwards.
    durationSeconds: seconds,
    resolution,
    count,
  }
}

const UPSCALE_TOKENS: Partial<Record<Resolution, Partial<Record<Resolution, number>>>> = {
  '360p': { '720p': 2896, '1080p': 5792 },
  '720p': { '1080p': 2896, '4k': 11584 },
}

export function upscaleOptions(from: Resolution, seconds: number) {
  if (!(seconds > 0 && seconds <= 15.05)) return []
  const targets = UPSCALE_TOKENS[from]
  if (!targets) return []
  return (Object.entries(targets) as [Resolution, number][]).map(([resolution, tokens]) => {
    const googleUsd = tokens * seconds * 12 / 1e6
    return { resolution, credits: Math.ceil(googleUsd / 0.08), googleUsd }
  })
}

export function estimate(p: Required<GenerationParams>): { credits: number; googleUsd: number } {
  const r = rule(p.modelKey)
  if (r.kind === 'image') {
    return { credits: Math.ceil((r.credits_per_image ?? 1) * p.count), googleUsd: r.google_usd_per_unit * p.count }
  }
  const rate = VIDEO_RATES[p.modelKey]?.[p.resolution]
  if (!rate) throw new Error(`No price for ${p.modelKey} at ${p.resolution}`)
  return { credits: Math.ceil(rate.credits * p.durationSeconds) * p.count, googleUsd: rate.usd * p.durationSeconds * p.count }
}

// Image upscale: a Gemini image model redraws the image at 2K or 4K, like Flow's image upscale.
// Two models: Nano Banana 2 (fast) and Nano Banana Pro (finer detail, costs more). Google bills
// their output image tokens: Nano Banana 2 at $60 per million (about 1,680 tokens at 2K and
// 2,520 at 4K); Pro at $120 per million (1,120 tokens at 2K, 2,000 at 4K).
export const IMAGE_UPSCALE_KEY = 'image-upscale'
export const IMAGE_UPSCALE_SIZES = ['2K', '4K', '2K-pro', '4K-pro'] as const
export type ImageUpscaleSize = (typeof IMAGE_UPSCALE_SIZES)[number]
export const IMAGE_UPSCALE_USD: Record<ImageUpscaleSize, number> = { '2K': 0.101, '4K': 0.151, '2K-pro': 0.134, '4K-pro': 0.24 }
export const imageUpscaleCredits = (size: ImageUpscaleSize) => Math.ceil(IMAGE_UPSCALE_USD[size] / 0.08)
// The size Google makes, and whether it's the Pro model.
export const imageUpscaleTarget = (size: ImageUpscaleSize) => ({ size: size.startsWith('4K') ? '4K' as const : '2K' as const, pro: size.endsWith('-pro') })
