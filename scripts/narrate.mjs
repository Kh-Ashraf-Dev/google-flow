// Turns scripts/narration.json into one voice clip per scene with ElevenLabs, for the demo
// recording. Clips are cached by text, so editing one line only regenerates that line.
//
//   node scripts/narrate.mjs                 all lines
//   node scripts/narrate.mjs --only intro    one line, to check the voice first
//   node scripts/narrate.mjs --placeholder   silent clips of a guessed length (no ElevenLabs call)
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ffmpeg from 'ffmpeg-static'

const root = resolve(import.meta.dirname, '..')
if (existsSync(join(root, '.env.local'))) process.loadEnvFile(join(root, '.env.local'))
const KEY = process.env.ELEVENLABS_API_KEY
const VOICE = process.env.ELEVENLABS_VOICE_ID
const MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_v4'

const args = process.argv.slice(2)
const placeholder = args.includes('--placeholder')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

const OUT = join(root, 'recordings', 'voice')
mkdirSync(OUT, { recursive: true })
const manifestFile = join(OUT, 'manifest.json')
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {}
const lines = Object.entries(JSON.parse(readFileSync(join(root, 'scripts', 'narration.json'), 'utf8'))).filter(([k]) => !k.startsWith('_'))

if (!placeholder && (!KEY || !VOICE)) {
  console.error('Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to .env.local (or use --placeholder).')
  process.exit(1)
}

function seconds(file) {
  const out = spawnSync(ffmpeg, ['-i', file], { encoding: 'utf8' }).stderr
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/)
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}

let chars = 0
for (const [key, text] of lines) {
  if (only && key !== only) continue
  const hash = createHash('sha1').update(`${placeholder ? 'silent' : MODEL + VOICE}:${text}`).digest('hex').slice(0, 12)
  const file = join(OUT, `${key}.mp3`)
  if (manifest[key]?.hash === hash && existsSync(file)) continue

  if (placeholder) {
    // Roughly how long Egyptian Arabic narration takes: ~13 characters a second.
    const d = Math.max(1.5, text.length / 13)
    spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', d.toFixed(2), '-q:a', '9', file])
  } else {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.45, similarity_boost: 0.85, style: 0.2, use_speaker_boost: true } }),
    })
    if (!res.ok) {
      console.error(`${key}: ElevenLabs returned ${res.status} ${(await res.text()).slice(0, 300)}`)
      process.exit(1)
    }
    writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    chars += text.length
  }
  manifest[key] = { hash, seconds: Number(seconds(file).toFixed(2)), text }
  console.log(`${key.padEnd(14)} ${manifest[key].seconds.toFixed(1)}s`)
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
const total = Object.values(manifest).reduce((s, m) => s + m.seconds, 0)
console.log(`\n${Object.keys(manifest).length} clips · ${total.toFixed(1)}s of narration${chars ? ` · ${chars} characters sent to ElevenLabs` : ''}`)
