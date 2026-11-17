// Characters: a person with a fixed look (1–3 reference images + text) and voice, reused in prompts.
import { useState } from 'react'
import type { ChangeEvent } from 'react'
import { api, type Character, type Job } from '../api.ts'
import { AssetPicker } from './AssetPicker.tsx'

type ListProps = {
  characters: Character[]
  inPrompt: number[]
  onToggle: (character: Character) => void
  onEdit: (character: Character | null) => void
  onDelete: (character: Character) => void
}

export function CharacterList({ characters, inPrompt, onToggle, onEdit, onDelete }: ListProps) {
  return (
    <div className="character-grid">
      <button className="scene-card character-new" onClick={() => onEdit(null)}>＋ New character</button>
      {characters.map((character) => (
        <div className="character-card" key={character.id}>
          <div className="character-images">
            {character.images.length ? character.images.map((image) => <img key={image.assetId} src={image.url} alt="" />)
              : <span className="faint small">Its images are in the Bin</span>}
          </div>
          <div className="character-body">
            <b dir="auto">{character.name}</b>
            {character.look && <span className="small muted one-line" dir="auto" title={character.look}>{character.look}</span>}
            {character.voice && <span className="small faint one-line" dir="auto" title={character.voice}>Voice · {character.voice}</span>}
            <div className="row tile-actions">
              <button className="btn sm" aria-pressed={inPrompt.includes(character.id)} onClick={() => onToggle(character)}>
                {inPrompt.includes(character.id) ? '✓ In prompt' : 'Use in prompt'}
              </button>
              <button className="btn sm secondary" onClick={() => onEdit(character)}>Edit</button>
              <button className="btn sm ghost bin-action" onClick={() => onDelete(character)}>Delete</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

type EditorProps = {
  character: Character | null
  jobs: Job[]
  uploading: boolean
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void
  onClose: () => void
  onSaved: (character: Character) => void
}

export function CharacterEditor({ character, jobs, uploading, onUpload, onClose, onSaved }: EditorProps) {
  const [name, setName] = useState(character?.name ?? '')
  const [look, setLook] = useState(character?.look ?? '')
  const [voice, setVoice] = useState(character?.voice ?? '')
  const [images, setImages] = useState(character?.images ?? [])
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function addImage(job: Job, asset: Job['assets'][number]) {
    if (job.kind !== 'image') { setError('Choose an image, not a video.'); return }
    if (images.some((image) => image.assetId === asset.id)) { setPicking(false); return }
    if (images.length >= 3) { setError('A character can have up to 3 images.'); return }
    setImages((list) => [...list, { assetId: asset.id, url: asset.url }])
    setError('')
    setPicking(false)
  }

  async function save() {
    setBusy(true)
    setError('')
    try {
      const body = { name, look, voice, assetIds: images.map((image) => image.assetId) }
      onSaved(character
        ? await api<Character>(`/characters/${character.id}`, body, 'PATCH')
        : await api<Character>('/characters', body))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-back" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      {picking && <AssetPicker jobs={jobs} uploading={uploading} error={error} onUpload={onUpload} onAdd={addImage} addLabel="Add to character" onClose={() => setPicking(false)} />}
      <div className="modal character-editor" role="dialog" aria-label={character ? 'Edit character' : 'New character'}
        onKeyDown={(event) => { if (event.key === 'Escape' && !picking && !busy) onClose() }}>
        <h3>{character ? 'Edit character' : 'New character'}</h3>
        <label className="field"><span>Name</span>
          <input className="input" dir="auto" maxLength={60} value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <div className="field">
          <span>Look · 1 to 3 images of the character</span>
          <div className="row character-picked">
            {images.map((image, index) => (
              <div className="character-thumb" key={image.assetId}>
                <img src={image.url} alt="" />
                <button className="icon-btn" aria-label={`Remove image ${index + 1}`} onClick={() => setImages((list) => list.filter((item) => item.assetId !== image.assetId))}>✕</button>
              </div>
            ))}
            {images.length < 3 && <button className="btn sm secondary" onClick={() => { setError(''); setPicking(true) }}>＋ Add image</button>}
          </div>
        </div>
        <label className="field"><span>Describe the look (optional)</span>
          <textarea className="input" dir="auto" rows={2} maxLength={800} placeholder="e.g. a man in his 40s, short grey beard, white galabiya"
            value={look} onChange={(event) => setLook(event.target.value)} />
        </label>
        <label className="field"><span>Voice</span>
          <textarea className="input" dir="auto" rows={2} maxLength={400} placeholder="e.g. deep, calm, slow Egyptian Arabic · صوت هادي وعميق"
            value={voice} onChange={(event) => setVoice(event.target.value)} />
          <span className="small faint">Videos describe the voice to the model; it isn’t a copy of a real person’s voice.</span>
        </label>
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="row">
          <div className="spacer" />
          <button className="btn sm ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn sm" disabled={busy || !name.trim() || !images.length} onClick={save}>{busy ? 'Checking…' : 'Save character'}</button>
        </div>
      </div>
    </div>
  )
}
