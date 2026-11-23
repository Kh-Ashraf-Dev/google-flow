// Scene builder: clips one after another on a timeline, played as one video (like Flow's Scenebuilder).
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, clipSeconds, clock, isPlayable, type Job, type Scene, type SceneClip } from '../api.ts'

type Props = {
  scene: Scene
  jobs: Job[]
  onChange: (scene: Scene) => void
  onClose: () => void
  onAllMedia: () => void
  onDeleted: () => void
  onExtend: (job: Job) => void
  extendingFrom: number | null
}

export function SceneBuilder({ scene, jobs, onChange, onClose, onAllMedia, onDeleted, onExtend, extendingFrom }: Props) {
  // Jobs are polled on the studio page, so take the freshest copy of each clip from there.
  const clips: SceneClip[] = useMemo(
    () => scene.clips.map((c) => ({ ...c, job: jobs.find((j) => j.id === c.job.id) ?? c.job })),
    [scene.clips, jobs],
  )
  // A trimmed clip plays [trimStart, trimEnd] of its video; times on the timeline are trimmed lengths.
  const fullLengths = clips.map((c) => clipSeconds(c.job))
  const trimStarts = clips.map((c) => c.trimStart ?? 0)
  const durations = clips.map((c, i) => Math.max((c.trimEnd ?? fullLengths[i]) - trimStarts[i], 0.1))
  const starts = durations.reduce<number[]>((acc, _d, i) => [...acc, i === 0 ? 0 : acc[i - 1] + durations[i - 1]], [])
  const total = durations.reduce((s, d) => s + d, 0)

  const [index, setIndex] = useState(0)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [name, setName] = useState(scene.name)
  const [busy, setBusy] = useState<'export' | null>(null)
  const [error, setError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const seekTo = useRef<number | null>(null)
  const local = useRef(0)
  // Where the playhead is right now; `t` only catches up when playback stops or seeks.
  const liveT = useRef(0)
  const playheadRef = useRef<HTMLDivElement>(null)
  const clockRef = useRef<HTMLSpanElement>(null)
  const ppsRef = useRef(18)
  function paint(time: number) {
    liveT.current = time
    if (playheadRef.current) playheadRef.current.style.left = `${time * ppsRef.current}px`
    if (clockRef.current) clockRef.current.textContent = `${clock(time)} / ${clock(total)}`
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- follow renames from the server
  useEffect(() => setName(scene.name), [scene.name])

  const current = clips[index]
  const currentUrl = current && isPlayable(current.job) ? current.job.assets[0].url : null
  const currentIsVideo = !!current?.job.assets[0]?.mime.startsWith('video')

  const nextPlayable = (from: number) => {
    for (let i = from; i < clips.length; i++) if (isPlayable(clips[i].job)) return i
    return -1
  }

  function goTo(i: number, offset = 0, keepPlaying = playing) {
    const n = nextPlayable(i)
    if (n < 0) {
      setPlaying(false)
      return
    }
    const off = n === i ? offset : 0
    local.current = off
    seekTo.current = trimStarts[n] + off
    setIndex(n)
    paint(starts[n] + off)
    setT(starts[n] + off)
    setPlaying(keepPlaying)
    if (n === index && videoRef.current && currentIsVideo) {
      videoRef.current.currentTime = trimStarts[n] + off
      seekTo.current = null
    }
  }

  // After a trim or split, put the player back at the start of the (now changed) clip.
  useEffect(() => {
    if (playing) return
    const off = Math.min(local.current, durations[index] ?? 0)
    if (videoRef.current && currentIsVideo) videoRef.current.currentTime = (trimStarts[index] ?? 0) + off
    paint((starts[index] ?? 0) + off)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clip's place on the timeline moved
    setT((starts[index] ?? 0) + off)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the server returns new clips
  }, [scene.clips])

  function seekGlobal(time: number) {
    const tt = Math.min(Math.max(time, 0), Math.max(total - 0.05, 0))
    let i = starts.findIndex((s, k) => tt >= s && tt < s + durations[k])
    if (i < 0) i = clips.length - 1
    goTo(i, tt - starts[i])
  }

  // Play / pause the video element, and move the playhead smoothly while playing.
  useEffect(() => {
    const v = videoRef.current
    if (v && currentIsVideo) {
      if (playing) v.play().catch(() => setPlaying(false))
      else v.pause()
    }
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      if (currentIsVideo && videoRef.current) local.current = videoRef.current.currentTime - trimStarts[index]
      else local.current += dt
      // Move the playhead and clock straight in the DOM: re-rendering the whole scene
      // (player, timeline, library) every frame is what made the timeline stutter.
      paint(starts[index] + Math.min(Math.max(local.current, 0), durations[index]))
      // Pictures (mock clips) have no "ended" event, and a trimmed video stops before its end,
      // so move on by time.
      if ((!currentIsVideo || clips[index].trimEnd != null) && local.current >= durations[index]) {
        const n = nextPlayable(index + 1)
        if (n < 0) { setPlaying(false); return }
        goTo(n, 0, true)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      setT(liveT.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per clip and play state only
  }, [playing, index, currentIsVideo, currentUrl])

  function onEnded() {
    const n = nextPlayable(index + 1)
    if (n < 0) { setPlaying(false); return }
    goTo(n, 0, true)
  }

  function togglePlay() {
    if (!clips.some((c) => isPlayable(c.job))) return
    if (!playing && liveT.current >= total - 0.1) { goTo(0, 0, true); return }
    if (!current || !isPlayable(current.job)) { goTo(index, 0, true); return }
    setPlaying(!playing)
  }

  async function save(next: Promise<Scene>) {
    setError('')
    try { onChange(await next) } catch (err) { setError((err as Error).message) }
  }

  const rename = () => { if (name.trim() && name.trim() !== scene.name) save(api<Scene>(`/scenes/${scene.id}`, { name })) }
  const remove = (clipId: number) => {
    setSelected(null)
    setPlaying(false)
    setIndex(0)
    paint(0)
    setT(0)
    save(api<Scene>(`/scenes/${scene.id}/clips/${clipId}`, undefined, 'DELETE'))
  }
  const add = (jobId: number) => save(api<Scene>(`/scenes/${scene.id}/clips`, { jobId }))
  // Trim and split work at the playhead, inside the selected clip, in seconds of its video.
  const trim = (clipId: number, start: number, end: number) => {
    setPlaying(false)
    local.current = 0
    save(api<Scene>(`/scenes/${scene.id}/clips/${clipId}/trim`, { start, end }))
  }
  const split = (clipId: number, at: number) => {
    setPlaying(false)
    local.current = 0
    save(api<Scene>(`/scenes/${scene.id}/clips/${clipId}/split`, { at }))
  }

  // Drag to reorder: optimistic, then saved.
  const dragFrom = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  function drop(to: number) {
    const from = dragFrom.current
    dragFrom.current = null
    setDragOver(null)
    if (from == null || from === to) return
    const order = [...scene.clips]
    const [moved] = order.splice(from, 1)
    order.splice(to > from ? to - 1 : to, 0, moved)
    setPlaying(false)
    onChange({ ...scene, clips: order })
    save(api<Scene>(`/scenes/${scene.id}/order`, { clipIds: order.map((c) => c.clipId) }))
  }

  async function exportScene() {
    setBusy('export')
    setError('')
    try {
      const res = await fetch(`/api/scenes/${scene.id}/export`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Export failed (${res.status})`)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `${scene.name}.mp4`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function deleteScene() {
    if (!confirm(`Delete “${scene.name}”? The clips stay in your library.`)) return
    await api(`/scenes/${scene.id}`, undefined, 'DELETE')
    onDeleted()
  }

  // Timeline scale: fit the scene in the track, but keep short clips readable.
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(800)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTrackWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const span = Math.max(total + 6, 16)
  const pps = Math.max((trackWidth - 24) / span, 18)
  useEffect(() => { ppsRef.current = pps }, [pps])
  const ticks = Array.from({ length: Math.ceil(span) + 1 }, (_, i) => i)

  function rulerSeek(e: React.MouseEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    seekGlobal((e.clientX - box.left + e.currentTarget.scrollLeft) / pps)
  }

  const last = clips.length ? clips[clips.length - 1] : null
  const sel = clips.find((c) => c.clipId === selected) ?? null
  const extendTarget = sel ?? last
  const library = jobs.filter((j) => j.kind === 'video' && j.status === 'succeeded')
  const aspect = clips.find((c) => isPlayable(c.job))?.job.params.aspectRatio ?? '16:9'

  return (
    <div className="scene">
      <div className="scene-head">
        <button className="btn sm secondary" onClick={onAllMedia} title="Back to all your images and videos"><span aria-hidden="true">←</span> All media</button>
        <button className="btn ghost sm" onClick={onClose}>▤ Scenes</button>
        <input className="scene-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        <span className="faint small num">{clips.length} clip{clips.length === 1 ? '' : 's'} · {clock(total)}</span>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={deleteScene}>Delete</button>
        <button className="btn sm secondary" disabled={busy !== null || !clips.some((c) => isPlayable(c.job))} onClick={exportScene}>
          {busy === 'export' ? 'Joining clips…' : 'Download as one video'}
        </button>
      </div>

      <div className={`player ${aspect === '9:16' ? 'tall' : ''}`}>
        {!current && <div className="faint">Add clips from your library or generate one below.</div>}
        {current && !isPlayable(current.job) && (
          <div className="col" style={{ alignItems: 'center', gap: 8 }}>
            <span className="strong">{current.job.status === 'failed' ? 'This clip failed' : 'This clip is still generating'}</span>
            <span className="faint small">Playback skips it</span>
          </div>
        )}
        {currentUrl && currentIsVideo && (
          <video
            // Per clip, not per file: the same video can sit in a scene twice, and a shared
            // element would keep the old position instead of seeking.
            key={current.clipId}
            ref={videoRef}
            src={currentUrl}
            playsInline
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = seekTo.current ?? trimStarts[index]
              seekTo.current = null
              if (playing) e.currentTarget.play().catch(() => setPlaying(false))
            }}
            onEnded={onEnded}
            onClick={togglePlay}
          />
        )}
        {currentUrl && !currentIsVideo && <img src={currentUrl} alt="" onClick={togglePlay} />}
      </div>

      <div className="transport">
        <button className="icon-btn" title="Previous clip" onClick={() => goTo(Math.max(index - 1, 0), 0)}>⏮</button>
        <button className="icon-btn play" title={playing ? 'Pause' : 'Play'} onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
        <button className="icon-btn" title="Next clip" onClick={() => goTo(Math.min(index + 1, clips.length - 1), 0)}>⏭</button>
        <span ref={clockRef} className="small num muted">{clock(t)} / {clock(total)}</span>
        <div className="spacer" />
        {extendTarget && (
          <button
            className="btn sm"
            disabled={!isPlayable(extendTarget.job) || extendingFrom === extendTarget.job.id}
            title="Make the next shot, starting from the last frame of this clip"
            onClick={() => onExtend(extendTarget.job)}
          >
            {extendingFrom === extendTarget.job.id ? 'Write what happens next ↓' : `＋ Extend clip ${clips.indexOf(extendTarget) + 1}`}
          </button>
        )}
        {sel && <button className="btn sm ghost" onClick={() => remove(sel.clipId)}>Remove from scene</button>}
      </div>
      {sel && isPlayable(sel.job) && (() => {
        const si = clips.indexOf(sel)
        const length = fullLengths[si]
        const end = sel.trimEnd ?? length
        // Where the playhead is inside the selected clip's video, if it's on that clip.
        const inside = t > starts[si] + 0.05 && t < starts[si] + durations[si] - 0.05
        const at = trimStarts[si] + (t - starts[si])
        const hint = inside ? `at ${at.toFixed(1)}s of the clip` : 'Move the playhead onto the selected clip first'
        return (
          <div className="trim-bar">
            <span className="small faint num">Clip {si + 1} · plays {trimStarts[si].toFixed(1)}–{end.toFixed(1)}s of {length.toFixed(1)}s</span>
            <div className="spacer" />
            <button className="btn sm secondary" disabled={!inside} title={`Start the clip here (${hint})`} onClick={() => trim(sel.clipId, at, end)}>⟦ Trim start</button>
            <button className="btn sm secondary" disabled={!inside} title={`End the clip here (${hint})`} onClick={() => trim(sel.clipId, trimStarts[si], at)}>Trim end ⟧</button>
            <button className="btn sm secondary" disabled={!inside} title={`Cut the clip in two (${hint})`} onClick={() => split(sel.clipId, at)}>✂ Split</button>
            {(sel.trimStart > 0 || sel.trimEnd != null) && <button className="btn sm ghost" onClick={() => trim(sel.clipId, 0, length)}>Reset trim</button>}
          </div>
        )
      })()}

      <div className="timeline" ref={trackRef}>
        <div className="ruler" onClick={rulerSeek} style={{ width: span * pps }}>
          {ticks.map((s) => (
            <span key={s} className={`tick ${s % 2 === 0 ? 'major' : ''}`} style={{ left: s * pps }}>{s % 2 === 0 ? clock(s) : ''}</span>
          ))}
        </div>
        <div className="track" style={{ width: span * pps }} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(clips.length)}>
          {clips.map((c, i) => {
            const running = c.job.status === 'running' || c.job.status === 'reserved'
            const a = c.job.assets[0]
            return (
              <div
                key={c.clipId}
                className={`clip ${running ? 'running' : ''} ${c.job.status === 'failed' ? 'failed' : ''} ${selected === c.clipId ? 'selected' : ''} ${dragOver === i ? 'drop-before' : ''} ${index === i ? 'current' : ''}`}
                style={{ width: durations[i] * pps - 4 }}
                draggable
                onDragStart={() => { dragFrom.current = i }}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(i) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => { e.stopPropagation(); drop(i) }}
                onClick={() => { setSelected(c.clipId === selected ? null : c.clipId); goTo(i, 0, false) }}
                title={c.job.promptOriginal}
              >
                {a && a.mime.startsWith('video') && <video src={`${a.url}#t=${(trimStarts[i] + 0.5).toFixed(2)}`} muted preload="metadata" />}
                {a && !a.mime.startsWith('video') && <img src={a.url} alt="" />}
                <span className="clip-label num">{i + 1} · {durations[i].toFixed(1).replace(/\.0$/, '')}s{c.trimStart > 0 || c.trimEnd != null ? ' · ✂' : ''}{c.job.sourceJobId ? ' · ↪' : ''}</span>
                {running && <span className="clip-state">Generating…</span>}
                {c.job.status === 'failed' && <span className="clip-state">Failed · refunded</span>}
              </div>
            )
          })}
          <button
            className="clip add"
            style={{ width: Math.max(4 * pps - 4, 72) }}
            disabled={!last || !isPlayable(last.job)}
            title={last ? 'Continue the scene from the last frame of the last clip' : 'Add a clip first'}
            onClick={() => last && onExtend(last.job)}
          >
            ＋<span className="small">Extend</span>
          </button>
        </div>
        {clips.length > 0 && <div ref={playheadRef} className="playhead" style={{ left: t * pps }} />}
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="col" style={{ gap: 10 }}>
        <div className="row">
          <span className="label">Your videos · add to the end of the scene</span>
          <div className="spacer" />
          <span className="faint small">Drag clips to reorder · select a clip and click the ruler to trim or split it</span>
        </div>
        {library.length === 0 ? (
          <div className="faint small">No finished videos yet.</div>
        ) : (
          <div className="library">
            {library.map((j) => (
              <div key={j.id} className="lib-item" title={j.promptOriginal}>
                {j.assets[0].mime.startsWith('video') ? <video src={`${j.assets[0].url}#t=0.5`} muted preload="metadata" /> : <img src={j.assets[0].url} alt="" />}
                <span className="clip-label num">{clipSeconds(j).toFixed(0)}s</span>
                <button className="btn sm secondary" onClick={() => add(j.id)}>＋ Add</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
