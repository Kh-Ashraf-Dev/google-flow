import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Job } from '../api.ts'

export type AssetCategory = 'all' | 'image' | 'video' | 'uploads'
export const ASSET_CATEGORIES = [
  { id: 'all', icon: '▦', label: 'All media' },
  { id: 'image', icon: '▧', label: 'Images' },
  { id: 'video', icon: '▹', label: 'Videos' },
  { id: 'uploads', icon: '⇧', label: 'Uploads' },
] as const

type Asset = Job['assets'][number]

type Props = {
  jobs: Job[]
  onClose: () => void
  onAdd?: (job: Job, asset: Asset) => void
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void
  uploading: boolean
  error: string
  addLabel?: string
}

export function AssetPicker({ jobs, onClose, onAdd, onUpload, uploading, error, addLabel = 'Add to prompt' }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [category, setCategory] = useState<AssetCategory>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('recent')
  const [selection, setSelection] = useState<number | null>(null)
  const filter = query.trim().toLocaleLowerCase()

  const assets = jobs.flatMap((job) => job.status === 'succeeded' ? job.assets.map((asset, index) => ({
    job, asset, name: job.assets.length > 1 ? job.promptOriginal + ' · ' + (index + 1) : job.promptOriginal,
  })) : []).filter(({ job, name }) =>
    (category === 'all' || (category === 'uploads' ? job.modelKey === 'upload' : job.kind === category)) &&
    name.toLocaleLowerCase().includes(filter))
  if (sort === 'oldest') assets.reverse()
  const selected = assets.find(({ asset }) => asset.id === selection) ?? assets[0]

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  return (
    <dialog className="asset-picker" ref={dialog} aria-label={onAdd ? 'Add media to prompt' : 'Library'} onCancel={(event) => {
      event.preventDefault()
      onClose()
    }} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="asset-picker-inner">
        <div className="asset-picker-heading">Library</div>
        <label className="asset-picker-search"><span aria-hidden="true">⌕</span>
          <input type="search" aria-label="Search assets" placeholder="Search assets" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="asset-picker-tools">
          <select aria-label="Sort assets" value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="recent">Recent</option><option value="oldest">Oldest</option>
          </select>
          <button className="icon-btn" aria-label="Close library" onClick={onClose}>✕</button>
        </div>
        <nav className="asset-categories" aria-label="Asset types">
          {ASSET_CATEGORIES.map(({ id, label, icon }) => (
            <button key={id} aria-pressed={category === id} onClick={() => { setCategory(id); setSelection(null) }}>
              <span aria-hidden="true">{icon}</span>{id === 'all' ? 'All' : label}
            </button>
          ))}
          <label className="asset-upload upload-image"><span aria-hidden="true">⇧</span>{uploading ? 'Uploading…' : 'Upload media'}
            <input type="file" aria-label="Upload media" multiple accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={onUpload} />
          </label>
        </nav>
        <div className="asset-picker-list" aria-label="Assets">
          {assets.length === 0 && <p className="muted small">No matching assets.</p>}
          {assets.map(({ job, asset, name }) => (
            <button key={asset.id} className="asset-row" title={name} aria-pressed={selected?.asset.id === asset.id}
              onClick={() => setSelection(asset.id)}>
              {asset.mime.startsWith('video/') ? <video src={asset.url} preload="metadata" muted /> : <img src={asset.url} alt="" />}
              <span>{name || (job.kind === 'video' ? 'Video' : 'Image')}</span>
            </button>
          ))}
        </div>
        <div className="asset-picker-preview">
          {selected && <>
            <div className="asset-preview-media">
              {selected.asset.mime.startsWith('video/')
                ? <video key={selected.asset.id} src={selected.asset.url} controls playsInline preload="metadata" />
                : <img src={selected.asset.url} alt={selected.name} />}
            </div>
            {onAdd && <button className="btn" onClick={() => onAdd(selected.job, selected.asset)}>{addLabel}</button>}
          </>}
        </div>
        {error && <div className="error-text asset-picker-error" role="alert">{error}</div>}
      </div>
    </dialog>
  )
}
