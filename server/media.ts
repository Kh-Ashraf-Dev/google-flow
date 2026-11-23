// Local video work with ffmpeg: the last frame of a clip (so the next clip can start from it)
// and joining a scene's clips into one MP4.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { config } from './config.ts'

const ffmpeg = ffmpegPath as unknown as string

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error(`ffmpeg: ${stderr.trim().split('\n').slice(-3).join(' ') || err.message}`))
      else resolve(stderr)
    })
  })
}

const mediaFile = (file: string) => join(config.dataDir, 'media', file)

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'studio-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

// A JPEG at most 3072 px on the long side, for sending a large upload to a model.
export function modelImage(file: string): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const out = join(dir, 'model.jpg')
    await run(['-y', '-i', mediaFile(file), '-vf', "scale='min(3072,iw)':'min(3072,ih)':force_original_aspect_ratio=decrease", '-q:v', '2', out])
    return readFileSync(out)
  })
}

// JPEG of the clip's last frame.
export function lastFrame(file: string): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const out = join(dir, 'last.jpg')
    await run(['-y', '-sseof', '-0.3', '-i', mediaFile(file), '-update', '1', '-q:v', '2', out])
    return readFileSync(out)
  })
}

// JPEG of the frame shown at `seconds` into the clip.
export function frameAt(file: string, seconds: number): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const out = join(dir, 'frame.jpg')
    // -ss after -i decodes up to the exact frame instead of jumping to the nearest keyframe.
    await run(['-y', '-i', mediaFile(file), '-ss', seconds.toFixed(3), '-frames:v', '1', '-q:v', '2', out])
    // The file's length can include audio past the last picture; near the end, take the last frame.
    return existsSync(out) ? readFileSync(out) : lastFrame(file)
  })
}

// The part of a clip from `start` to `end` seconds as a new MP4. Re-encoding makes the cut
// frame-accurate; the sound (if any) is kept.
export function trimClip(file: string, start: number, end: number): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const out = join(dir, 'trim.mp4')
    await run(['-y', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', mediaFile(file),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', out])
    return readFileSync(out)
  })
}

function hasAudio(path: string): Promise<boolean> {
  // `ffmpeg -i` with no output exits non-zero but lists the streams.
  return new Promise((resolve) => execFile(ffmpeg, ['-hide_banner', '-i', path], (_e, _o, se) => resolve(/Stream #\d+:\d+.*Audio:/.test(se))))
}

// Joins a scene's clips in order.
export type ClipPart = { file: string; start: number; end: number | null }

export function joinClips(clips: ClipPart[], aspectRatio: string): Promise<Buffer> {
  const [w, h] = aspectRatio === '9:16' ? [720, 1280] : [1280, 720]
  return withTempDir((dir) => joinPaths(dir, clips.map((clip) => ({ ...clip, path: mediaFile(clip.file) })), w, h))
}

const FRAME_HEIGHT: Record<string, number> = { '360p': 360, '720p': 720, '1080p': 1080, '4k': 2160 }

// An extended clip: the clip it continues, then the new piece, as one MP4 at the new piece's size.
export function appendClip(file: string, next: Buffer, aspectRatio: string, resolution: string): Promise<Buffer> {
  const short = FRAME_HEIGHT[resolution] ?? 720
  const long = Math.round(short * 16 / 9)
  const [w, h] = aspectRatio === '9:16' ? [short, long] : [long, short]
  return withTempDir(async (dir) => {
    const piece = join(dir, 'next.mp4')
    writeFileSync(piece, next)
    return joinPaths(dir, [{ path: mediaFile(file), start: 0, end: null }, { path: piece, start: 0, end: null }], w, h)
  })
}

// Each clip is scaled and padded to one frame size and given a stereo track (silence if it has
// none), then they are concatenated.
async function joinPaths(dir: string, clips: { path: string; start: number; end: number | null }[], w: number, h: number) {
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-ar', '48000', '-ac', '2']
  const parts: string[] = []
  for (const [i, clip] of clips.entries()) {
    const part = join(dir, `part${i}.mp4`)
    const audioIn = (await hasAudio(clip.path)) ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest']
    // Only the trimmed part of the clip; re-encoding keeps the cut frame-accurate.
    const trim = [...(clip.start > 0 ? ['-ss', clip.start.toFixed(3)] : []), ...(clip.end != null ? ['-to', clip.end.toFixed(3)] : [])]
    await run(['-y', ...trim, '-i', clip.path, ...audioIn, '-vf', vf, ...enc, part])
    parts.push(part)
  }
  const out = join(dir, 'joined.mp4')
  const graph = parts.map((_, i) => `[${i}:v][${i}:a]`).join('') + `concat=n=${parts.length}:v=1:a=1[v][a]`
  await run(['-y', ...parts.flatMap((p) => ['-i', p]), '-filter_complex', graph, '-map', '[v]', '-map', '[a]', ...enc, '-movflags', '+faststart', out])
  return readFileSync(out)
}
