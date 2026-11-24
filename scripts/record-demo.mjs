// Records a real run of the demo: employee makes an image and a video, another employee gets
// blocked, and the admin checks who used what. Drives the system Chrome with puppeteer-core,
// captures frames over CDP, and encodes them with ffmpeg-static.
//
// Usage: npm run dev (in another terminal), then: node scripts/record-demo.mjs
// Spends real Google credit if Vertex AI is configured: one image and one 4s 720p video.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ffmpeg from 'ffmpeg-static'
import puppeteer from 'puppeteer-core'

const BASE = process.env.DEMO_URL ?? 'http://localhost:5173'
const OUT_DIR = resolve(import.meta.dirname, '..', 'recordings')
const FRAMES = join(OUT_DIR, 'frames')
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))

const IMAGE_PROMPT = 'فوانيس رمضان ذهبية معلقة فوق شارع قديم في القاهرة وقت المغرب'
const VIDEO_PROMPT = 'فوانيس رمضان بتنوّر واحدة ورا التانية في شارع قديم في القاهرة، والكاميرا ماشية لقدّام ببطء'
const BLOCKED_PROMPT = 'صورة الصحابة وهم داخلين المدينة المنورة'

rmSync(FRAMES, { recursive: true, force: true })
mkdirSync(FRAMES, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  args: ['--autoplay-policy=no-user-gesture-required', '--lang=en-US', '--window-size=1440,900'],
})
const page = await browser.newPage()

// A caption bar so the recording explains itself.
await page.evaluateOnNewDocument(() => {
  window.__cap = (text) => {
    let el = document.getElementById('__cap')
    if (!el) {
      el = document.createElement('div')
      el.id = '__cap'
      el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;background:rgba(10,10,10,.88);color:#fff;border:1px solid #3a3c3f;border-radius:999px;padding:10px 22px;font:500 17px "IBM Plex Sans Arabic",Inter,sans-serif;direction:rtl;box-shadow:0 8px 30px rgba(0,0,0,.5);max-width:80%;text-align:center'
      document.body.appendChild(el)
    }
    el.textContent = text
    el.style.display = text ? 'block' : 'none'
  }
})

// ---- frame capture ----
const frames = []
const speedups = []
const cdp = await page.createCDPSession()
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const file = join(FRAMES, `${String(frames.length).padStart(5, '0')}.jpg`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  frames.push({ file, t: metadata.timestamp })
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1440, maxHeight: 900, everyNthFrame: 1 })
const now = () => Date.now() / 1000

// ---- helpers ----
const btn = (t) => `::-p-xpath(//button[normalize-space(.)="${t}"])`
const seg = (t) => `::-p-xpath(//div[contains(@class,"seg")]//button[normalize-space(.)="${t}"])`
const nav = (t) => `::-p-xpath(//nav//a[normalize-space(.)="${t}"])`
const h3 = (t) => `::-p-xpath(//h3[normalize-space(.)="${t}"])`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cap = (text) => page.evaluate((t) => window.__cap(t), text)

// Voice-over from scripts/narrate.mjs, if it has been generated. Each scene records when it
// started, and waits for its line unless the line is meant to play over the next actions.
const voiceManifest = join(OUT_DIR, 'voice', 'manifest.json')
const voice = existsSync(voiceManifest) ? JSON.parse(readFileSync(voiceManifest, 'utf8')) : {}
const events = []
let voiceEnd = 0
async function scene(key, caption, { hold = 0, over = false } = {}) {
  if (now() < voiceEnd) await sleep((voiceEnd - now()) * 1000)
  events.push({ key, t: now() })
  await cap(caption)
  const d = voice[key]?.seconds ?? 0
  voiceEnd = now() + d + 0.3
  if (!over) await sleep(Math.max(hold, (d + 0.4) * 1000))
}
async function click(selector) {
  const el = await page.waitForSelector(selector, { visible: true, timeout: 15000 })
  await el.scrollIntoView()
  await sleep(250)
  await el.click()
  await sleep(400)
}
async function type(selector, text) {
  await click(selector)
  await page.keyboard.type(text, { delay: 45 })
  await sleep(500)
}
async function signIn(name) {
  await page.goto(BASE, { waitUntil: 'networkidle0' })
  const email = `${name.split(' ')[0].toLowerCase()}@awqaf.demo`
  await type('input[type="email"]', email)
  await type('input[type="password"]', 'demo1234')
  await click(btn('Sign in'))
  await page.waitForSelector('.topbar', { timeout: 15000 })
  await sleep(800)
}
async function signOut() {
  await click(btn('Sign out'))
  await page.waitForSelector('.login', { timeout: 15000 })
}
async function waitFast(selector, timeout) {
  // Waiting for Google is sped up in the final video.
  const start = now()
  await page.waitForSelector(selector, { timeout })
  speedups.push({ from: start, to: now(), factor: 12 })
}

try {
  // 1. Employee signs in
  await signIn('Saif Sabry')
  await scene('intro', 'سيف (موظف في إدارة الإعلام) داخل بحساب المنصة، مش بإيميل شخصي', { hold: 2500 })

  // 2. Image
  await click(seg('Image'))
  await click(seg('×1'))
  await scene('image_prompt', 'بيكتب البرومبت بالعربي', { over: true })
  await type('.composer textarea', IMAGE_PROMPT)
  await click(btn('Check prompt'))
  await scene('image_check', 'Gemini بيفحص البرومبت حسب سياسة المحتوى ويترجمه ويحسّنه', { over: true })
  await page.waitForSelector('.suggestion textarea', { timeout: 120000 })
  await sleep(2000)
  await scene('image_cost', 'شايف التكلفة قبل ما يولّد: 1 كريدت', { hold: 2000 })
  await click('::-p-xpath(//div[@class="suggestion"]//button[normalize-space(.)="Generate"])')
  await cap('بيتولّد بـ Nano Banana 2')
  await page.waitForSelector('.tile:not(.running) .imgs img', { timeout: 120000 })
  await sleep(1000)
  await scene('image_ready', 'الصورة جاهزة، والكريدت اتخصم من رصيده', { hold: 4000 })

  // 3. Video
  await click(seg('Video'))
  await scene('video_setup', 'دلوقتي فيديو: 4 ثواني، جودة draft عشان التجربة', { over: true })
  await type('.composer textarea', VIDEO_PROMPT)
  await click(btn('Check prompt'))
  await page.waitForSelector('.suggestion textarea', { timeout: 120000 })
  await sleep(3000)
  await click('::-p-xpath(//div[@class="suggestion"]//button[normalize-space(.)="Generate"])')
  await scene('video_wait', 'الكريدت اتحجز، والفيديو بيتعمل بـ Veo 3.1 Lite (الانتظار متسرّع في التسجيل)', { over: true })
  await waitFast('.media-grid > .tile:first-child:not(.running) .media > :is(video, img)', 8 * 60 * 1000)
  await scene('video_ready', 'الفيديو جاهز، واتحاسب على مدته الحقيقية', { hold: 7000 })
  await click(nav('Usage & credits'))
  await scene('usage', 'سيف شايف رصيده واستهلاكه النهارده وكل عملية', { hold: 4500 })
  await signOut()

  // 4. Another employee hits the content policy (blocklist: no Google call, no cost)
  await signIn('Mona Nabil')
  await cap('منى (إدارة التواصل) بتطلب حاجة ممنوعة في سياسة الوزارة')
  await type('.composer textarea', BLOCKED_PROMPT)
  await click(btn('Check prompt'))
  await page.waitForSelector('.notice.danger', { timeout: 30000 })
  await scene('blocked', 'اتمنعت فوراً، ومفيش ولا كريدت اتخصم', { hold: 4500 })
  await signOut()

  // 5. Admin
  await signIn('Omar Khaled')
  await click(nav('Admin'))
  await scene('admin', 'عمر (الأدمن) شايف رصيد الوزارة وتكلفة جوجل النهارده', { hold: 4000 })
  await click(seg('Today'))
  const report = await page.$(h3('Who used what'))
  await report?.scrollIntoView()
  await scene('who_used_what', 'مين استهلك قد إيه: كريدت، فيديوهات، صور، واللي اتمنع', { hold: 5500 })
  const people = await page.$(h3('People'))
  await people?.scrollIntoView()
  await scene('limits', 'حد يومي لكل موظف، والأدمن يقدر يغيّره أو يدي كريدت زيادة', { hold: 5000 })
  const latest = await page.$(h3('Latest generations'))
  await latest?.scrollIntoView()
  await scene('log', 'كل عملية متسجّلة، واللي اتمنع باين', { hold: 4500 })
  if (now() < voiceEnd) await sleep((voiceEnd - now()) * 1000)
  await cap('')
  await sleep(800)
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {})
  await sleep(300)
  await browser.close()
}

// ---- encode ----
// Screencast only sends a frame when something changes, so each frame lasts until the next.
const factorAt = (t) => speedups.find((s) => t >= s.from && t < s.to)?.factor ?? 1
const durations = frames.map((f, i) => Math.max(((frames[i + 1]?.t ?? f.t + 1.5) - f.t) / factorAt(f.t), 0.01))
const starts = []
durations.reduce((acc, d, i) => { starts[i] = acc; return acc + d }, 0)
// Wall-clock time → time in the finished video.
const outTime = (t) => {
  let i = frames.findIndex((f) => f.t > t) - 1
  if (i < 0) i = t < frames[0].t ? 0 : frames.length - 1
  return starts[i] + Math.min(t - frames[i].t, durations[i] * factorAt(frames[i].t)) / factorAt(frames[i].t)
}

// Place each voice line at its scene; if the previous line is still playing, start right after it.
const clips = []
let prevEnd = 0
for (const e of events) {
  const v = voice[e.key]
  if (!v) continue
  const at = Math.max(outTime(e.t), prevEnd + 0.15)
  clips.push({ file: join(OUT_DIR, 'voice', `${e.key}.mp3`), at })
  prevEnd = at + v.seconds
}
const videoLength = starts.at(-1) + durations.at(-1)
if (prevEnd + 0.8 > videoLength) durations[durations.length - 1] += prevEnd + 0.8 - videoLength

const lines = []
frames.forEach((f, i) => lines.push(`file '${f.file.replace(/\\/g, '/')}'`, `duration ${durations[i].toFixed(3)}`))
lines.push(`file '${frames.at(-1).file.replace(/\\/g, '/')}'`)
const list = join(FRAMES, 'list.txt')
writeFileSync(list, lines.join('\n'))
const out = join(OUT_DIR, clips.length ? 'studio-demo-voice.mp4' : 'studio-demo.mp4')
const ffArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', list]
for (const c of clips) ffArgs.push('-i', c.file)
if (clips.length) {
  const delays = clips.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`).join(';')
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[aout]`
  ffArgs.push('-filter_complex', `[0:v]fps=30,format=yuv420p[v];${delays};${mix}`, '-map', '[v]', '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k')
} else {
  ffArgs.push('-vf', 'fps=30,format=yuv420p')
}
ffArgs.push('-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', out)
const res = spawnSync(ffmpeg, ffArgs, { stdio: 'inherit' })
if (res.status !== 0) process.exit(res.status ?? 1)
writeFileSync(join(OUT_DIR, 'timeline.json'), JSON.stringify(clips.map((c) => ({ ...c, file: c.file.split(/[\\/]/).pop() })), null, 2))
rmSync(FRAMES, { recursive: true, force: true })
console.log(`\nSaved ${out} (${frames.length} frames, ${clips.length} voice lines)`)
