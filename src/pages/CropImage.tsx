import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'

type Box = { x: number; y: number; width: number; height: number }
type Props = { url: string; onSave: (file: Blob) => Promise<void>; onClose: () => void }

const INITIAL: Box = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
const RATIOS = [
  { label: 'Free', ratio: 0 },
  { label: 'Square', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
]
const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), Math.max(max, 0))

function encode(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((file) => file ? resolve(file) : reject(new Error('Could not create the cropped image.')), type, quality)
  })
}

export function CropImage({ url, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; x: number; y: number; box: Box } | null>(null)
  const [box, setBox] = useState<Box>(INITIAL)
  const [ratio, setRatio] = useState(0)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function chooseRatio(value: number) {
    const source = image.current
    if (!source || !ready) return
    setRatio(value)
    if (!value) return
    const relative = value * source.naturalHeight / source.naturalWidth
    const width = Math.min(1, relative)
    const height = width / relative
    setBox({ x: (1 - width) / 2, y: (1 - height) / 2, width, height })
  }

  function resize(axis: 'width' | 'height', fraction: number) {
    setBox((previous) => {
      const width = axis === 'width' ? fraction : previous.width
      const height = axis === 'height' ? fraction : previous.height
      return {
        x: clamp(previous.x + (previous.width - width) / 2, 1 - width),
        y: clamp(previous.y + (previous.height - height) / 2, 1 - height),
        width, height,
      }
    })
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current
    const bounds = preview.current?.getBoundingClientRect()
    if (!start || !bounds || start.pointerId !== event.pointerId || !bounds.width || !bounds.height) return
    setBox({
      ...start.box,
      x: clamp(start.box.x + (event.clientX - start.x) / bounds.width, 1 - start.box.width),
      y: clamp(start.box.y + (event.clientY - start.y) / bounds.height, 1 - start.box.height),
    })
  }

  async function save() {
    const source = image.current
    if (!source || !ready || saving) return
    setSaving(true)
    setError('')
    try {
      const x = Math.min(source.naturalWidth - 1, Math.round(box.x * source.naturalWidth))
      const y = Math.min(source.naturalHeight - 1, Math.round(box.y * source.naturalHeight))
      const width = Math.max(1, Math.min(source.naturalWidth - x, Math.round(box.width * source.naturalWidth)))
      const height = Math.max(1, Math.min(source.naturalHeight - y, Math.round(box.height * source.naturalHeight)))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not open the crop canvas.')
      context.drawImage(source, x, y, width, height, 0, 0, width, height)
      const maxBytes = 20 * 1024 * 1024
      let file = await encode(canvas, 'image/png')
      if (file.size > maxBytes) file = await encode(canvas, 'image/webp', 0.9)
      if (file.size > maxBytes) throw new Error('The crop is larger than 20 MB. Select a smaller area.')
      await onSave(file)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <dialog className="crop-dialog" ref={dialog} aria-labelledby="crop-title" onCancel={(event) => {
      event.preventDefault()
      if (!saving) onClose()
    }}>
      <h2 id="crop-title">Crop image</h2>
      <div className="seg" aria-label="Crop aspect ratio">
        {RATIOS.map((option) => (
          <button type="button" key={option.label} disabled={!ready || saving}
            className={ratio === option.ratio ? 'on' : ''} aria-pressed={ratio === option.ratio}
            onClick={() => chooseRatio(option.ratio)}>{option.label}</button>
        ))}
      </div>
      <div className="crop-stage">
        <div className="crop-preview" ref={preview}>
          <img ref={image} src={url} alt="Image to crop" draggable={false} onLoad={() => setReady(true)}
            onError={() => setError('The image could not be loaded.')} />
          {ready && <div className="crop-selection" aria-hidden="true"
            style={{ left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.width * 100 + '%', height: box.height * 100 + '%' }}
            onPointerDown={(event) => {
              if (saving || event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, box }
            }}
            onPointerMove={move}
            onLostPointerCapture={() => { drag.current = null }} />}
        </div>
      </div>
      <div className="crop-controls">
        {ratio === 0 && <>
          <label>Width<input type="range" min="10" max="100" step="1" value={Math.round(box.width * 100)}
            disabled={!ready || saving} onChange={(event) => resize('width', Number(event.target.value) / 100)} /></label>
          <label>Height<input type="range" min="10" max="100" step="1" value={Math.round(box.height * 100)}
            disabled={!ready || saving} onChange={(event) => resize('height', Number(event.target.value) / 100)} /></label>
        </>}
        <label>Horizontal position<input type="range" min="0" max="100"
          value={box.width < 1 ? Math.round(box.x / (1 - box.width) * 100) : 0}
          disabled={!ready || saving || box.width >= 1}
          onChange={(event) => setBox({ ...box, x: Number(event.target.value) / 100 * (1 - box.width) })} /></label>
        <label>Vertical position<input type="range" min="0" max="100"
          value={box.height < 1 ? Math.round(box.y / (1 - box.height) * 100) : 0}
          disabled={!ready || saving || box.height >= 1}
          onChange={(event) => setBox({ ...box, y: Number(event.target.value) / 100 * (1 - box.height) })} /></label>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="row">
        <button className="btn sm secondary" disabled={saving} onClick={() => { setRatio(0); setBox({ x: 0, y: 0, width: 1, height: 1 }) }}>Reset</button>
        <div className="spacer" />
        <button className="btn sm secondary" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn sm" disabled={!ready || saving} onClick={save}>{saving ? 'Saving…' : 'Save crop'}</button>
      </div>
    </dialog>
  )
}
