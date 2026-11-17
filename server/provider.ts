// Every model call goes through here, so moving from the Gemini API to Vertex AI
// later means a second implementation of this file, not changes across the app.
import { config } from './config.ts'
import { generateContent, generateOmni, generateVeo } from './vertex.ts'

export type PolicyRuleInput = { id: number; name: string; description: string; action: 'block' | 'review' }

export type PromptReview = {
  allowed: boolean
  needsReview: boolean
  ruleIds: number[]
  reasonEn: string
  reasonAr: string
  enhancedPrompt: string
  safeAlternative: string
  sourceLanguage: 'ar' | 'en' | 'other'
}

export type ImageResult = { mime: string; bytes: Buffer }[]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function reviewInstruction(rules: PolicyRuleInput[], editImage: boolean) {
  return `You check prompts for a video and image studio used by the Egyptian Ministry of Awqaf. You do not rewrite or improve them.

Content policy (each rule has an id and an action):
${rules.map((r) => `- [${r.id}] (${r.action}) ${r.name}: ${r.description}`).join('\n')}

Do this:
1. Detect the prompt language. Users usually write in Egyptian or Modern Standard Arabic.
2. Decide if the prompt breaks a rule. A "block" rule match means allowed=false. A "review" rule match keeps allowed=true but sets needs_review=true. Only flag real matches, not loose associations.
3. If allowed, fill enhanced_prompt with the user's prompt exactly as written when it is in English. When it is in another language, translate it into English literally and faithfully: add nothing, remove nothing, no extra description or style words.${editImage ? ' Preserve any image numbers and the requested role of each reference.' : ''}
4. If blocked, leave enhanced_prompt empty and write safe_alternative: an English prompt that keeps the moment but removes what broke the rule (for example, show the place with no people).
5. reason_en and reason_ar: one short sentence each explaining a block or review to the user. Empty if fine.`
}

const reviewSchema = {
  type: 'OBJECT',
  properties: {
    allowed: { type: 'BOOLEAN' },
    needs_review: { type: 'BOOLEAN' },
    rule_ids: { type: 'ARRAY', items: { type: 'INTEGER' } },
    reason_en: { type: 'STRING' },
    reason_ar: { type: 'STRING' },
    enhanced_prompt: { type: 'STRING' },
    safe_alternative: { type: 'STRING' },
    source_language: { type: 'STRING', enum: ['ar', 'en', 'other'] },
  },
  required: ['allowed', 'needs_review', 'rule_ids', 'reason_en', 'reason_ar', 'enhanced_prompt', 'safe_alternative', 'source_language'],
}

const isArabic = (s: string) => /[؀-ۿ]/.test(s)

export async function reviewPrompt(prompt: string, rules: PolicyRuleInput[], editImage = false): Promise<PromptReview> {
  if (config.mock) {
    return {
      allowed: true, needsReview: false, ruleIds: [], reasonEn: '', reasonAr: '',
      enhancedPrompt: isArabic(prompt)
        ? '[Mock translation] Cinematic shot of the scene described, warm golden light, slow dolly forward, shallow depth of field'
        : prompt.trim(),
      safeAlternative: '', sourceLanguage: isArabic(prompt) ? 'ar' : 'en',
    }
  }
  const request = {
    systemInstruction: { parts: [{ text: reviewInstruction(rules, editImage) }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: reviewSchema, temperature: 0.4 },
  }
  let out
  try {
    out = await generateContent(config.models.helper, request)
  } catch (err) {
    // Still busy after retries: fall back to the previous Flash so a demo doesn't stall.
    const status = (err as { status?: number }).status
    if (status !== 429 && status !== 503) throw err
    out = await generateContent(config.models.helperFallback, request)
  }
  const text = out?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '{}'
  const r = JSON.parse(text)
  return {
    allowed: !!r.allowed, needsReview: !!r.needs_review, ruleIds: r.rule_ids ?? [],
    reasonEn: r.reason_en ?? '', reasonAr: r.reason_ar ?? '',
    enhancedPrompt: r.enhanced_prompt ?? '', safeAlternative: r.safe_alternative ?? '',
    sourceLanguage: r.source_language ?? 'other',
  }
}

export type StartFrame = { mime: string; bytes: Buffer }

export async function generateVideo(
  model: string,
  prompt: string,
  params: { aspectRatio: string; durationSeconds: number; resolution: string },
  startFrame?: StartFrame,
  references: StartFrame[] = [],
  // A video to edit (Omni only).
  video?: StartFrame,
  // The image the video ends on (Veo 3.1, Omni 1.2).
  endFrame?: StartFrame,
): Promise<{ mime: string; bytes: Buffer }> {
  if (config.mock) {
    await sleep(8000)
    return { mime: 'image/svg+xml', bytes: Buffer.from(mockSvg(prompt, params.durationSeconds, params.aspectRatio)) }
  }
  if (model.startsWith('gemini-omni-')) {
    return generateOmni(model, prompt, params, startFrame, references, video, endFrame)
  }
  if (video) throw new Error('Video editing needs an Omni model')
  return generateVeo(model, prompt, params, startFrame, references, endFrame)
}

// Seconds of video in an MP4, read from the movie header box. Used to bill the real length.
export function mp4Seconds(buf: Buffer): number | null {
  const i = buf.indexOf('mvhd')
  if (i < 0) return null
  const version = buf[i + 4]
  const timescale = version === 1 ? buf.readUInt32BE(i + 24) : buf.readUInt32BE(i + 16)
  const duration = version === 1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20)
  return timescale ? duration / timescale : null
}

// Gemini image models (Nano Banana) return one image per request, so we send `count` requests.
async function generateOneImage(model: string, prompt: string, aspectRatio: string, sources: StartFrame[]): Promise<{ mime: string; bytes: Buffer } | null> {
  const parts = [
    ...sources.map((source) => ({ inlineData: { mimeType: source.mime, data: source.bytes.toString('base64') } })),
    { text: prompt },
  ]
  const out = await generateContent(model, {
    contents: [{ role: 'user', parts }],
    generationConfig: sources.length
      ? { responseModalities: ['TEXT', 'IMAGE'] }
      : { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
  })
  const part = out?.candidates?.[0]?.content?.parts?.find((x: { inlineData?: { data: string } }) => x.inlineData?.data)
  if (!part) return null
  return { mime: part.inlineData.mimeType ?? 'image/png', bytes: Buffer.from(part.inlineData.data, 'base64') }
}

export async function generateImages(model: string, prompt: string, p: { aspectRatio: string; count: number }, sources: StartFrame[] = []): Promise<ImageResult> {
  if (config.mock) {
    return Array.from({ length: p.count }, (_, i) => ({ mime: 'image/svg+xml', bytes: Buffer.from(mockSvg(prompt, i, p.aspectRatio)) }))
  }
  const results = await Promise.allSettled(Array.from({ length: p.count }, () => generateOneImage(model, prompt, p.aspectRatio, sources)))
  const images = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
  if (!images.length) {
    const err = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    if (err) throw err.reason
    throw Object.assign(new Error('Google’s safety filter returned no images'), { safety: true })
  }
  return images
}

export function mockSvg(prompt: string, seed: number, aspect: string) {
  const [w, h] = aspect === '9:16' ? [720, 1280] : [1280, 720]
  const hue = (prompt.length * 37 + seed * 61) % 360
  const safe = prompt.replace(/[<>&]/g, '').slice(0, 80)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,28%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,12%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="50%" y="46%" fill="#fff" font-family="sans-serif" font-size="${w / 26}" text-anchor="middle" opacity=".9">Mock output · no Google call</text>
<text x="50%" y="56%" fill="#fff" font-family="sans-serif" font-size="${w / 48}" text-anchor="middle" opacity=".6">${safe}</text></svg>`
}
