// Preset voices for characters, like Flow's voice ingredients. Vertex's video models take no voice
// input, so a preset reaches Veo/Omni as a text description; the sample you hear is Gemini TTS with
// a matching voice and style, so the video's voice is close to it, not identical.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'
import { generateContent } from './vertex.ts'

export type VoicePreset = {
  id: string
  label: string
  labelAr: string
  gender: 'male' | 'female'
  // Sent to the video model as the character's voice.
  prompt: string
  // Gemini TTS prebuilt voice and delivery for the sample. Google lists no genders for these
  // voices; they were picked by their commonly reported sound.
  ttsVoice: string
  ttsStyle: string
}

export const VOICES: VoicePreset[] = [
  { id: 'narrator-man', label: 'Calm narrator', labelAr: 'راوي هادي', gender: 'male', ttsVoice: 'Charon',
    ttsStyle: 'calm, clear and steady, like a documentary narrator', prompt: 'a calm, clear adult male narrator voice with a steady pace' },
  { id: 'deep-elder', label: 'Deep elder', labelAr: 'شيخ صوته عميق', gender: 'male', ttsVoice: 'Algenib',
    ttsStyle: 'deep, slow and dignified, like a wise older man', prompt: 'a deep, slow, dignified older male voice, slightly gravelly' },
  { id: 'warm-man', label: 'Warm man', labelAr: 'راجل صوته دافي', gender: 'male', ttsVoice: 'Umbriel',
    ttsStyle: 'warm, friendly and relaxed', prompt: 'a warm, friendly adult male voice at a relaxed pace' },
  { id: 'young-man', label: 'Young man', labelAr: 'شاب حيوي', gender: 'male', ttsVoice: 'Puck',
    ttsStyle: 'upbeat and lively, a young man in his twenties', prompt: 'an upbeat, lively young male voice, in his twenties' },
  { id: 'firm-man', label: 'Firm speaker', labelAr: 'خطيب حازم', gender: 'male', ttsVoice: 'Orus',
    ttsStyle: 'firm, confident and clear, addressing a crowd', prompt: 'a firm, confident, clear adult male voice that projects well' },
  { id: 'excited-man', label: 'Excited host', labelAr: 'مذيع متحمس', gender: 'male', ttsVoice: 'Fenrir',
    ttsStyle: 'excited and energetic, like a TV host', prompt: 'an energetic, excited male TV-host voice' },
  { id: 'narrator-woman', label: 'Clear narrator', labelAr: 'راوية واضحة', gender: 'female', ttsVoice: 'Kore',
    ttsStyle: 'clear, firm and steady, like a narrator', prompt: 'a clear, steady adult female narrator voice' },
  { id: 'warm-woman', label: 'Warm woman', labelAr: 'ست صوتها دافي', gender: 'female', ttsVoice: 'Sulafat',
    ttsStyle: 'warm, kind and gentle', prompt: 'a warm, kind adult female voice at a gentle pace' },
  { id: 'young-woman', label: 'Young woman', labelAr: 'شابة', gender: 'female', ttsVoice: 'Leda',
    ttsStyle: 'youthful and bright, a young woman in her twenties', prompt: 'a bright, youthful female voice, in her twenties' },
  { id: 'cheerful-woman', label: 'Cheerful host', labelAr: 'مذيعة مرحة', gender: 'female', ttsVoice: 'Zephyr',
    ttsStyle: 'bright and cheerful, like a TV host', prompt: 'a bright, cheerful female TV-host voice' },
  { id: 'mature-woman', label: 'Mature woman', labelAr: 'ست كبيرة', gender: 'female', ttsVoice: 'Gacrux',
    ttsStyle: 'mature, calm and wise', prompt: 'a mature, calm older female voice' },
  { id: 'soft-woman', label: 'Soft voice', labelAr: 'صوت ناعم', gender: 'female', ttsVoice: 'Achernar',
    ttsStyle: 'soft and gentle, close to the microphone', prompt: 'a soft, gentle female voice, close to the microphone' },
]

export const voicePreset = (id: string | null | undefined) => VOICES.find((voice) => voice.id === id)

// What the video model is told about a character's voice: the preset, then any notes of the user's.
export function voiceText(presetId: string | null | undefined, notes: string) {
  const preset = voicePreset(presetId)
  return [preset?.prompt, notes.trim()].filter(Boolean).join('. ')
}

const SAMPLE_TEXT = 'أهلاً بيكم. النهارده هنحكي حكاية جميلة من شوارع القاهرة القديمة.'
const pending = new Map<string, Promise<Buffer>>()

// The sample is made once per voice and kept on disk.
export function voiceSample(id: string): Promise<Buffer> {
  const preset = voicePreset(id)
  if (!preset) return Promise.reject(new Error('Unknown voice'))
  const dir = join(config.dataDir, 'voices')
  const file = join(dir, `${preset.id}${config.mock ? '-mock' : ''}.wav`)
  if (existsSync(file)) return Promise.resolve(readFileSync(file))
  const running = pending.get(file)
  if (running) return running
  const job = (async () => {
    const wav = config.mock ? toneWav(preset.gender === 'male' ? 150 : 260) : await ttsWav(preset)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, wav)
    return wav
  })().finally(() => pending.delete(file))
  pending.set(file, job)
  return job
}

async function ttsWav(preset: VoicePreset): Promise<Buffer> {
  const out = await generateContent(config.models.tts, {
    contents: [{ role: 'user', parts: [{ text: SAMPLE_TEXT, speechMetadata: { style: preset.ttsStyle } }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: preset.ttsVoice } } },
  })
  const part = out?.candidates?.[0]?.content?.parts?.find((x: { inlineData?: { data: string } }) => x.inlineData?.data)
  if (!part) throw new Error('Gemini TTS returned no audio')
  const bytes = Buffer.from(part.inlineData.data, 'base64')
  // Vertex returns a WAV file; raw 16-bit PCM (24 kHz mono) gets a WAV header.
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' ? bytes : wavFromPcm(bytes, 24000)
}

function wavFromPcm(pcm: Buffer, rate: number) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

// Mock mode: a short tone instead of a Google call.
function toneWav(hz: number) {
  const rate = 24000
  const pcm = Buffer.alloc(rate * 2)
  for (let i = 0; i < rate; i++) {
    const fade = Math.min(1, i / 2400, (rate - i) / 2400)
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000 * fade), i * 2)
  }
  return wavFromPcm(pcm, rate)
}
