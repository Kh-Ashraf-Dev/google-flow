// A clip on its own page (opened by clicking a video): play it, extend it from its end or from any
// frame, edit it with a prompt, trim it (saved as a new clip), upscale, download or delete it.
// The prompt box stays below, so Extend and Edit video are written right here.
import { useEffect, useRef, useState } from 'react'
import { clipSeconds, clock, posterUrl, timeAgo, type Job, type Params } from '../api.ts'

type Asset = Job['assets'][number]
type Props = {
  job: Job
  notice?: string
  // Videos made from this one (extensions, trims, upscales, edits) and the one it was made from.
  related: Job[]
  source: Job | null
  onOpen: (job: Job) => void
  onBack: () => void
  // Saves the kept part as a new clip; the page then shows that clip with `notice`.
  onTrim: (job: Job, start: number, end: number) => Promise<void>
  onExtend: (job: Job) => void
  onContinueFrom: (job: Job, seconds: number) => Promise<void>
  onEditVideo: (job: Job) => void
  // What the prompt box below is set to do with this clip, if anything.
  using: 'extend' | 'edit' | null
  onUpscale: (job: Job, resolution: NonNullable<Params['resolution']>) => void
  upscaling: number | null
  onFavorite: (assetId: number, value: boolean) => Promise<void>
  onReuse: (job: Job) => void
  onNewScene: (job: Job) => void
  onTrash: (assetId: number) => Promise<void>
  onSaveFrame: (job: Job, seconds: number) => void
  savingFrame: boolean
}

const STEP = 0.1
const MIN_LENGTH = 0.5
const fixed = (n: number) => clock(n) + '.' + Math.floor((n % 1) * 10)
const res = (r: string) => r === '4k' ? '4K' : r

export function VideoViewer({ job, notice, related, source, onOpen, onBack, onTrim, onExtend, onContinueFrom, onEditVideo, using, onUpscale, upscaling, onFavorite, onReuse, onNewScene, onTrash, onSaveFrame, savingFrame }: Props) {
  const video = useRef<HTMLVideoElement>(null)
  const asset: Asset | undefined = job.assets[0]
  const playable = !!asset?.mime.startsWith('video')
  const [length, setLength] = useState(() => clipSeconds(job))
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(() => clipSeconds(job))
  const [at, setAt] = useState(0)
  const [busy, setBusy] = useState<'trim' | 'frame' | null>(null)
  const [error, setError] = useState('')
  const trimmed = start > 0.05 || end < length - 0.05
  const extended = job.params.extendedSeconds

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const typing = (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable]')
      if (event.key === 'Escape' && !busy && !typing && !document.querySelector('.setting-pop, .modal-back')) onBack()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [busy, onBack])

  // Playing a trimmed clip plays only the kept part.
  function timeUpdate() {
    const element = video.current
    if (!element) return
    setAt(element.currentTime)
    if (trimmed && !element.paused && element.currentTime >= end) {
      element.pause()
      element.currentTime = end
    }
  }
  function play() {
    const element = video.current
    if (element && trimmed && (element.currentTime < start || element.currentTime >= end - 0.05)) element.currentTime = start
  }
  const seek = (seconds: number) => { if (video.current) video.current.currentTime = seconds; setAt(seconds) }
  const setFrom = (value: number) => { const next = Math.min(Math.max(0, value), end - MIN_LENGTH); setStart(next); seek(next) }
  const setTo = (value: number) => { const next = Math.max(Math.min(length, value), start + MIN_LENGTH); setEnd(next); seek(next) }

  async function trim() {
    setBusy('trim')
    setError('')
    try {
      await onTrim(job, start, end)
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  async function continueFrom() {
    setBusy('frame')
    setError('')
    try {
      await onContinueFrom(job, video.current?.currentTime ?? at)
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  const p = job.params
  return (
    <div className="clip-page" role="region" aria-label="Clip">
      <div className="clip-head">
        <button className="btn sm secondary clip-back" onClick={onBack} title="Back to all your images and videos (Esc)">
          <span aria-hidden="true">←</span> All media
        </button>
        <span className="clip-crumb faint small">{source ? <>Made from <button className="link-btn" onClick={() => onOpen(source)}>an earlier clip</button></> : 'Clip'}</span>
        <div className="spacer" />
        {asset && <button className={`btn sm secondary favorite-btn${asset.favorite ? ' on' : ''}`} aria-pressed={asset.favorite}
          onClick={() => onFavorite(asset.id, !asset.favorite)}>{asset.favorite ? '★ Favorite' : '☆ Favorite'}</button>}
        {asset && <a className="btn sm secondary" href={asset.url} download>↓ Download</a>}
      </div>

      <div className="clip-body">
        <div className="clip-stage">
          <div className="clip-player">
            {playable ? (
              <video key={asset.url} ref={video} src={asset.url} poster={posterUrl(asset.url)} controls autoPlay playsInline preload="auto"
                onLoadedMetadata={(event) => {
                  const seconds = event.currentTarget.duration
                  // The real length replaces the estimate; an untouched end handle moves to the real end.
                  if (Number.isFinite(seconds) && seconds > 0) { setEnd((value) => Math.abs(value - length) < 0.05 ? seconds : Math.min(value, seconds)); setLength(seconds) }
                }}
                onTimeUpdate={timeUpdate} onSeeked={timeUpdate} onPlay={play} />
            ) : asset ? <img src={asset.url} alt="" /> : null}
          </div>

          {playable ? (
            <div className="trim">
              <div className="trim-track" style={{ ['--from' as string]: `${(start / length) * 100}%`, ['--to' as string]: `${(end / length) * 100}%`, ['--at' as string]: `${(Math.min(at, length) / length) * 100}%` }}>
                <div className="trim-kept" />
                <div className="trim-head" />
                {!!extended && extended < length && <div className="trim-join" style={{ left: `${((length - extended) / length) * 100}%` }} title="Where the extension starts" />}
                <input type="range" className="trim-handle" aria-label="Clip starts at" min={0} max={length} step={STEP} value={start}
                  onChange={(event) => setFrom(Number(event.target.value))} />
                <input type="range" className="trim-handle" aria-label="Clip ends at" min={0} max={length} step={STEP} value={end}
                  onChange={(event) => setTo(Number(event.target.value))} />
              </div>
              <div className="row trim-row small num">
                <button className="btn sm secondary" onClick={() => setFrom(video.current?.currentTime ?? at)} title="Start the clip at the frame you’re on">⟦ Start here</button>
                <span className="faint">{fixed(start)} – {fixed(end)} · keeps {fixed(end - start)} of {fixed(length)}</span>
                <button className="btn sm secondary" onClick={() => setTo(video.current?.currentTime ?? at)} title="End the clip at the frame you’re on">End here ⟧</button>
                {trimmed && <button className="btn sm ghost" onClick={() => { setStart(0); setEnd(length) }}>Reset</button>}
                <div className="spacer" />
                <button className="btn sm" disabled={!trimmed || busy !== null} onClick={trim}
                  title="Save the part between the handles as a new clip (free)">{busy === 'trim' ? 'Trimming…' : '✂ Save trimmed clip'}</button>
              </div>
            </div>
          ) : <span className="faint small">Mock clips are pictures, so trimming and frames work only with real videos.</span>}
          {error && <div className="error-text" role="alert">{error}</div>}
          {notice && !error && <div className="notice info small" role="status">{notice}</div>}
        </div>

        <aside className="clip-side">
          <div className="clip-info">
            <span className="prompt" dir="auto">{job.promptOriginal}</span>
            <div className="clip-tags small num">
              {extended ? <span className="clip-tag accent">↪ Extended · {fixed(Math.max(length - extended, 0))} + {fixed(extended)}</span> : null}
              <span className="clip-tag">{clock(length)}</span>
              {p.resolution && <span className="clip-tag">{res(p.resolution)}</span>}
              {p.aspectRatio && <span className="clip-tag">{p.aspectRatio}</span>}
              <span className="clip-tag">{job.modelKey === 'upload' ? 'edited here' : job.modelKey}</span>
              <span className="faint">{timeAgo(job.createdAt)}</span>
            </div>
          </div>

          <div className="clip-group">
            <span className="clip-group-title">Next shot · اللقطة الجاية</span>
            <button className={`clip-action primary${using === 'extend' ? ' on' : ''}`} onClick={() => onExtend(job)}>
              <span className="clip-action-icon" aria-hidden="true">↪</span>
              <span><b>{using === 'extend' ? 'Extending this clip' : 'Extend'}</b><small>{using === 'extend' ? 'Write what happens next in the prompt below ↓' : 'Continue from the last frame, joined into one longer video'}</small></span>
            </button>
            {playable && (
              <button className="clip-action" disabled={busy !== null} onClick={continueFrom}>
                <span className="clip-action-icon" aria-hidden="true">⧉</span>
                <span><b>{busy === 'frame' ? 'Saving frame…' : `Continue from ${fixed(at)}`}</b><small>Pause where you want; that frame starts the next video</small></span>
              </button>
            )}
          </div>

          <div className="clip-group">
            <span className="clip-group-title">Change · تعديل</span>
            <button className={`clip-action${using === 'edit' ? ' on' : ''}`} onClick={() => onEditVideo(job)}>
              <span className="clip-action-icon" aria-hidden="true">✎</span>
              <span><b>{using === 'edit' ? 'Editing this video' : 'Edit video'}</b><small>{using === 'edit' ? 'Describe the change in the prompt below ↓' : 'Change it with a prompt (Omni keeps the rest)'}</small></span>
            </button>
          </div>

          {!!job.upscaleOptions?.length && (
            <div className="clip-group">
              <span className="clip-group-title">Upscale · جودة أعلى</span>
              <div className="clip-chips">
                {job.upscaleOptions.map(({ resolution, credits }) => (
                  <button key={resolution} className="btn sm secondary" disabled={upscaling !== null} onClick={() => onUpscale(job, resolution)}>
                    {upscaling === job.id ? 'Starting…' : `${res(resolution)} · ${credits} cr`}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="clip-group">
            <span className="clip-group-title">More</span>
            <div className="clip-chips">
              {playable && <button className="btn sm secondary" disabled={savingFrame} title="Save the frame you’re on as an image in your gallery"
                onClick={() => onSaveFrame(job, video.current?.currentTime ?? at)}>{savingFrame ? 'Saving…' : `⧉ Save frame ${fixed(at)}`}</button>}
              <button className="btn sm secondary" onClick={() => onNewScene(job)}>▤ Add to scene</button>
              {job.promptOriginal && <button className="btn sm secondary" onClick={() => onReuse(job)}>↺ Reuse prompt</button>}
              {asset && <button className="btn sm ghost bin-action" onClick={() => { void onTrash(asset.id); onBack() }}>Delete</button>}
            </div>
          </div>

          {related.length > 0 && (
            <div className="clip-group">
              <span className="clip-group-title">Made from this clip · {related.length}</span>
              <div className="clip-related">
                {related.map((item) => (
                  <button key={item.id} className="clip-related-item" onClick={() => onOpen(item)} title={item.promptOriginal}>
                    {item.status === 'succeeded' && item.assets[0]
                      ? <img src={item.assets[0].mime.startsWith('video') ? posterUrl(item.assets[0].url) : item.assets[0].url} alt="" />
                      : <span className="faint small">{item.status === 'failed' ? 'Failed' : 'Making…'}</span>}
                    <small>{item.params.extendedSeconds ? '↪ Extended' : item.modelKey === 'upload' ? '✂ Trimmed' : item.params.resolution ? res(item.params.resolution) : ''}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
