import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactElement } from 'react'
import { studioPath, type AppProps, type StudioView } from '../App.tsx'
import { api, ApiError, clipSeconds, clock, fmt, isArabic, timeAgo, uploadStudioImage, type Character, type Check, type Collection, type Job, type Params, type PickedImage, type Project, type ReuseInputs, type Scene, type Source } from '../api.ts'
import { SceneBuilder } from './Scene.tsx'
import { CropImage } from './CropImage.tsx'
import { AssetPicker, ASSET_CATEGORIES } from './AssetPicker.tsx'
import { CharacterEditor, CharacterList } from './Characters.tsx'

type Kind = 'video' | 'image'
type SelectedImage = PickedImage
type Favorite = (assetId: number, value: boolean) => Promise<void>
type Rename = (assetId: number, name: string) => Promise<void>
type SettingName = 'model' | 'format' | 'count'
type MentionOption = {
  key: string
  label: string
  kind: 'character' | 'image' | 'video'
  thumb?: string
  video?: boolean
  named?: boolean
  character?: Character
  job?: Job
  asset?: Job['assets'][number]
}
// separate: one video per image · references: one video using them all · frames: image 1 starts it, image 2 ends it
type ImageMode = 'separate' | 'references' | 'frames'

function removeAsset(jobs: Job[], assetId: number) {
  return jobs.flatMap((job) => {
    if (!job.assets.some((asset) => asset.id === assetId)) return [job]
    const assets = job.assets.filter((asset) => asset.id !== assetId)
    return assets.length ? [{ ...job, assets }] : []
  })
}

// The editing model, chosen when "Edit video" is picked with a model that can't edit.
const EDIT_MODEL = 'omni-flash-1.2'
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp']
type ImageRole = 'start' | 'end' | 'ingredient'
const ROLE_LABEL: Record<ImageRole, string> = { start: 'Start', end: 'End', ingredient: 'Ingredient' }
const ROLE_HELP: Record<ImageRole, string> = {
  start: 'The video starts on this image',
  end: 'The video ends on this image (needs exactly two images)',
  ingredient: 'Use this image as a reference in one video (up to 3 images)',
}
const canEditVideo = (modelKey: string) => modelKey.startsWith('omni-')

// Per-viewer preferences; storage can be blocked, so every access is guarded.
function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key)
    return value && (allowed as readonly string[]).includes(value) ? value as T : fallback
  } catch {
    return fallback
  }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* not saved; the default comes back next visit */ }
}

const DEFAULTS: Record<Kind, Params> = {
  video: { modelKey: 'veo-3.1-lite', aspectRatio: '16:9', durationSeconds: 4, resolution: '720p', count: 1 },
  image: { modelKey: 'gemini-image', aspectRatio: '16:9', count: 2 },
}

export function Studio({ me, refreshMe, navigate, projectId, view }: AppProps & { projectId: number; view: StudioView }) {
  const [project, setProject] = useState<Project | null>(null)
  const [projectMissing, setProjectMissing] = useState(false)
  const [jobs, setJobs] = useState<Job[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(true)
  const [collections, setCollections] = useState<Collection[]>([])
  // Which view is open comes from the URL, so Back/Forward and refresh land in the same place.
  const activeCollection = view.collectionId
  const mediaFilter = view.filter
  const [collectionMedia, setCollectionMedia] = useState<{ id: number; jobs: Job[] } | null>(null)
  const [collectionVersion, setCollectionVersion] = useState(0)
  const [creatingCollection, setCreatingCollection] = useState(false)
  const [bin, setBin] = useState<{ jobs: Job[]; collections: Collection[] } | null>(null)
  const [layout, setLayoutState] = useState<'batch' | 'grid'>(() => stored('studio.layout', 'grid', ['batch', 'grid'] as const))
  const setLayout = (value: 'batch' | 'grid') => { setLayoutState(value); store('studio.layout', value) }
  const [keepPrompt, setKeepPromptState] = useState(() => stored('studio.keepPrompt', 'on', ['on', 'off'] as const) === 'on')
  const setKeepPrompt = (value: boolean) => { setKeepPromptState(value); store('studio.keepPrompt', value ? 'on' : 'off') }
  const [savingFrame, setSavingFrame] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [favoriteJobs, setFavoriteJobs] = useState<Job[] | null>(null)
  const [favoritesVersion, setFavoritesVersion] = useState(0)
  const [upscalingImage, setUpscalingImage] = useState<number | null>(null)
  const [characters, setCharacters] = useState<Character[]>([])
  const [promptCharacters, setPromptCharacters] = useState<number[]>([])
  const [editingCharacter, setEditingCharacter] = useState<Character | null | 'new'>(null)
  // Which settings popover is open above the prompt: model, format (shape · resolution · length) or count.
  const [openSetting, setOpenSetting] = useState<SettingName | null>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const composerDock = useRef<HTMLDivElement>(null)
  const panelBody = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = workspace.current
    const dock = composerDock.current
    const body = panelBody.current
    if (!container || !dock || !body) return
    // The notices above the composer float over the bottom of the page too, so the page
    // gets that much extra room at the bottom to scroll its last row clear of them.
    const syncHeight = () => {
      container.style.setProperty('--composer-dock-height', Math.ceil(dock.getBoundingClientRect().height) + 'px')
      container.style.setProperty('--composer-body-height', Math.ceil(body.getBoundingClientRect().height) + 'px')
    }
    syncHeight()
    const observer = new ResizeObserver(syncHeight)
    observer.observe(dock)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  // A settings popover closes on Esc or a click anywhere but its chip or itself, and opens on its current choice.
  useEffect(() => {
    if (!openSetting) return
    document.querySelector<HTMLElement>('.setting-pop [aria-pressed="true"]')?.focus()
    const down = (event: MouseEvent) => {
      if (!(event.target as Element).closest?.('.setting-pop, .setting-chip')) setOpenSetting(null)
    }
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpenSetting(null)
      document.querySelector<HTMLElement>(`.setting-chip[data-setting="${openSetting}"]`)?.focus()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [openSetting])
  const toggleSetting = (name: SettingName) => setOpenSetting((open) => open === name ? null : name)
  const [kind, setKind] = useState<Kind>('video')
  const [params, setParams] = useState<Params>(DEFAULTS.video)
  const [prompt, setPrompt] = useState('')
  const [check, setCheck] = useState<Check | null>(null)
  const checkedAt = useRef(0)
  const [finalPrompt, setFinalPrompt] = useState('')
  const [cost, setCost] = useState<number | null>(null)
  const [busy, setBusy] = useState<'generate' | null>(null)
  const [pending, setPending] = useState<{ prompt: string; kind: Kind; count: number } | null>(null)
  const [error, setError] = useState('')
  const [scenes, setScenes] = useState<Scene[]>([])
  const [scenesLoaded, setScenesLoaded] = useState(false)
  const scene = view.sceneId != null ? scenes.find((item) => item.id === view.sceneId) ?? null : null
  const [source, setSource] = useState<Source | null>(null)
  const [editImages, setEditImages] = useState<SelectedImage[]>([])
  const [cropImage, setCropImage] = useState<SelectedImage | null>(null)
  const [uploading, setUploading] = useState(false)
  const [upscaling, setUpscaling] = useState<number | null>(null)
  const [images, setImages] = useState<SelectedImage[]>([])
  const [imageMode, setImageMode] = useState<ImageMode>('separate')
  const chosenCharacters = promptCharacters.flatMap((id) => characters.filter((item) => item.id === id))
  const characterImages = chosenCharacters.reduce((sum, item) => sum + item.images.length, 0)
  // A plain video prompt with characters sends their pictures as reference images.
  const characterReferences = kind === 'video' && characterImages > 0 && images.length === 0 && !source
  const usesReferences = kind === 'video' && ((images.length > 0 && imageMode === 'references') || characterReferences)
  const usesFrames = kind === 'video' && images.length > 0 && imageMode === 'frames'
  const enoughReferences = (!usesReferences || images.length + characterImages >= (characterImages ? 1 : 2)) && (!usesFrames || images.length === 2)
  const jobsRef = useRef(jobs)
  useEffect(() => { jobsRef.current = jobs }, [jobs])

  const loadJobs = useCallback(async () => setJobs(await api<Job[]>(`/jobs?project=${projectId}`)), [projectId])
  const loadScenes = useCallback(async () => {
    setScenes(await api<Scene[]>(`/scenes?project=${projectId}`))
    setScenesLoaded(true)
  }, [projectId])
  useEffect(() => {
    api<Project>(`/projects/${projectId}`).then((item) => {
      setProject(item)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
      loadJobs()
      loadScenes()
      api<Collection[]>(`/collections?project=${projectId}`).then(setCollections).catch((err: Error) => setError(err.message))
      api<Character[]>('/characters').then(setCharacters).catch((err: Error) => setError(err.message))
    }).catch((err) => {
      if (err instanceof ApiError && err.status === 400) setProjectMissing(true)
      else setError((err as Error).message)
    })
  }, [projectId, loadJobs, loadScenes])

  // Opening another view starts it with an empty search and no old error.
  function go(next: Partial<StudioView>) {
    setSearch('')
    setError('')
    navigate(studioPath(projectId, next))
  }

  async function renameProject(value: string) {
    if (!project) return
    const name = value.trim()
    if (!name || name === project.name) return
    try {
      setProject(await api<Project>(`/projects/${projectId}`, { name }, 'PATCH'))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    if (activeCollection === null) return
    let current = true
    api<Job[]>(`/collections/${activeCollection}/jobs`).then((items) => {
      if (current) setCollectionMedia({ id: activeCollection, jobs: items })
    }).catch((err: Error) => {
      if (current) {
        setCollectionMedia({ id: activeCollection, jobs: [] })
        setError(err.message)
      }
    })
    return () => { current = false }
  }, [activeCollection, collectionVersion])

  useEffect(() => {
    if (mediaFilter !== 'bin') return
    let current = true
    api<{ jobs: Job[]; collections: Collection[] }>(`/bin?project=${projectId}`).then((result) => {
      if (current) setBin(result)
    }).catch((err: Error) => {
      if (current) { setBin({ jobs: [], collections: [] }); setError(err.message) }
    })
    return () => { current = false }
  }, [mediaFilter, projectId])

  useEffect(() => {
    if (mediaFilter !== 'favorites' || activeCollection !== null) return
    let current = true
    api<Job[]>(`/jobs?project=${projectId}&favorites=1`).then((items) => {
      if (current) setFavoriteJobs(items)
    }).catch((err: Error) => {
      if (current) { setFavoriteJobs([]); setError(err.message) }
    })
    return () => { current = false }
  }, [mediaFilter, activeCollection, projectId, favoritesVersion])

  function showBin() {
    if (mediaFilter === 'bin') return
    setBin(null)
    go({ filter: 'bin' })
  }

  const patchAsset = (assetId: number, patch: Partial<Job['assets'][number]>) => (list: Job[]) => list.map((job) => job.assets.some((asset) => asset.id === assetId)
    ? { ...job, assets: job.assets.map((asset) => asset.id === assetId ? { ...asset, ...patch } : asset) } : job)

  // A name lets you mention the image or video in a prompt with @.
  const renameAsset: Rename = async (assetId, name) => {
    setError('')
    try {
      const saved = await api<{ name: string | null }>(`/assets/${assetId}/name`, { name }, 'PUT')
      setJobs(patchAsset(assetId, saved))
      setCollectionMedia((previous) => previous && { ...previous, jobs: patchAsset(assetId, saved)(previous.jobs) })
      setFavoriteJobs((previous) => previous && patchAsset(assetId, saved)(previous))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const setFavorite: Favorite = async (assetId, value) => {
    setError('')
    try {
      await api(`/assets/${assetId}/favorite`, undefined, value ? 'PUT' : 'DELETE')
      setJobs(patchAsset(assetId, { favorite: value }))
      setCollectionMedia((previous) => previous && { ...previous, jobs: patchAsset(assetId, { favorite: value })(previous.jobs) })
      setFavoriteJobs((previous) => previous && (value ? patchAsset(assetId, { favorite: value })(previous) : removeAsset(previous, assetId)))
      setFavoritesVersion((version) => version + 1)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function upscaleImage(assetId: number, size: '2K' | '4K') {
    setUpscalingImage(assetId)
    setError('')
    try {
      const created = await api<Job>(`/assets/${assetId}/upscale`, { size })
      setJobs((previous) => [created, ...previous])
      if (created.status === 'failed') setError(`Upscale failed: ${created.error ?? 'no image came back'}. The credits were refunded.`)
      await refreshMe()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUpscalingImage(null)
    }
  }

  function toggleCharacter(character: Character) {
    setError('')
    setPromptCharacters((list) => {
      if (list.includes(character.id)) return list.filter((id) => id !== character.id)
      if (list.length >= 3) { setError('Use up to 3 characters in one prompt.'); return list }
      return [...list, character.id]
    })
  }

  async function deleteCharacter(character: Character) {
    setError('')
    try {
      await api(`/characters/${character.id}`, undefined, 'DELETE')
      setCharacters((list) => list.filter((item) => item.id !== character.id))
      setPromptCharacters((list) => list.filter((id) => id !== character.id))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function dismissJob(jobId: number) {
    setError('')
    try {
      await api(`/jobs/${jobId}`, undefined, 'DELETE')
      setJobs((previous) => previous.filter((job) => job.id !== jobId))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function moveAssetToBin(assetId: number) {
    setError('')
    try {
      await api(`/assets/${assetId}`, undefined, 'DELETE')
      setJobs((previous) => removeAsset(previous, assetId))
      setCollectionMedia((previous) => previous && { ...previous, jobs: removeAsset(previous.jobs, assetId) })
      setImages((previous) => previous.filter((asset) => asset.assetId !== assetId))
      if (editImages.some((asset) => asset.assetId === assetId)) {
        setEditImages((previous) => previous.filter((asset) => asset.assetId !== assetId))
        setCheck(null)
      }
      if (source?.job.assets.some((asset) => asset.id === assetId)) setSource(null)
      await loadScenes()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function moveCollectionToBin(id: number) {
    setError('')
    try {
      await api(`/collections/${id}`, undefined, 'DELETE')
      setCollections((previous) => previous.filter((item) => item.id !== id))
      if (activeCollection === id) go({})
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function restoreFromBin(type: 'assets' | 'collections', id: number) {
    setError('')
    try {
      await api(`/${type}/${id}/restore`, {})
      setBin((previous) => previous && (type === 'assets'
        ? { ...previous, jobs: removeAsset(previous.jobs, id) }
        : { ...previous, collections: previous.collections.filter((item) => item.id !== id) }))
      if (type === 'assets') {
        setCollectionVersion((version) => version + 1)
        await Promise.all([loadJobs(), loadScenes()])
      } else {
        setCollections(await api<Collection[]>(`/collections?project=${projectId}`))
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function openCollection(id: number) {
    go({ collectionId: id })
  }

  async function createCollection() {
    setCreatingCollection(true)
    setError('')
    try {
      const item = await api<Collection>('/collections', { projectId })
      setCollections((previous) => [...previous, item])
      setCollectionsOpen(true)
      openCollection(item.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreatingCollection(false)
    }
  }

  async function renameCollection(item: Collection, value: string) {
    const name = value.trim() || item.name
    if (name === item.name) return
    try {
      const updated = await api<Collection>(`/collections/${item.id}`, { name }, 'PATCH')
      setCollections((previous) => previous.map((entry) => entry.id === item.id ? updated : entry))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function changeCollectionAsset(id: number, assetId: number, add: boolean) {
    setError('')
    try {
      await api(`/collections/${id}/assets/${assetId}`, undefined, add ? 'PUT' : 'DELETE')
      setCollectionVersion((version) => version + 1)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function updateScene(next: Scene) {
    setScenes((prev) => [next, ...prev.filter((x) => x.id !== next.id)])
  }

  async function newScene(jobIds: number[] = []) {
    const created = await api<Scene>('/scenes', { jobIds, projectId })
    updateScene(created)
    go({ sceneId: created.id })
    return created
  }

  // Next video starts from the last frame of this clip (Flow's "Extend").
  function extendFrom(job: Job) {
    setImages([])
    setEditImages([])
    setSource({ job, mode: 'extend' })
    if (kind !== 'video') { setKind('video'); setParams(DEFAULTS.video) }
    setCheck(null)
  }

  // Change a finished video with a prompt. Only Omni edits, and the result keeps the clip's length.
  function editVideo(job: Job) {
    setImages([])
    setEditImages([])
    setImageMode('separate')
    setSource({ job, mode: 'edit' })
    setKind('video')
    setParams((previous) => {
      const base = kind === 'video' ? previous : DEFAULTS.video
      return { ...base, modelKey: canEditVideo(base.modelKey) ? base.modelKey : EDIT_MODEL, count: 1 }
    })
    setCheck(null)
    setError('')
  }

  async function saveFrame(job: Job, seconds: number) {
    setSavingFrame(job.id)
    setError('')
    try {
      const frame = await api<Job>(`/jobs/${job.id}/frame`, { seconds })
      setJobs((previous) => [frame, ...previous])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingFrame(null)
    }
  }

  async function extendInNewScene(job: Job) {
    try {
      await newScene([job.id])
      extendFrom(job)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function selectImage(job: Job, assetId: number) {
    const asset = job.assets.find((item) => item.id === assetId)
    if (!asset) return
    if (images.some((item) => item.assetId === assetId)) {
      setImages((previous) => previous.filter((item) => item.assetId !== assetId))
      setError('')
      return
    }
    const max = imageMode === 'frames' ? 2 : imageMode === 'references' ? 3 : 4
    if (images.length >= max) {
      setError(`Choose up to ${max} images for this mode.`)
      return
    }
    setImages((previous) => [...previous, { jobId: job.id, assetId, url: asset.url }])
    setSource(null)
    if (editImages.length) { setEditImages([]); setCheck(null) }
    setError('')
    if (kind !== 'video') {
      setKind('video')
      setParams(DEFAULTS.video)
    }
    if (imageMode === 'references') selectReferenceModel()
    if (imageMode === 'frames') selectFramesModel()
  }

  function startEdit(job: Job, assetId: number) {
    if (busy) return
    const asset = job.assets.find((item) => item.id === assetId)
    if (!asset) return
    const alreadySelected = editImages.some((image) => image.assetId === assetId)
    if (!alreadySelected && editImages.length >= 3) {
      setError('Choose up to 3 images to edit or combine.')
      return
    }
    setKind('image')
    if (!editImages.length) setParams(kind === 'image' ? { ...params, count: 1 } : { ...DEFAULTS.image, count: 1 })
    setImages([])
    setSource(null)
    setEditImages((previous) => alreadySelected
      ? previous.filter((image) => image.assetId !== assetId)
      : [...previous, { jobId: job.id, assetId, url: asset.url }])
    setCheck(null)
    setError('')
  }

  function openLibrary() {
    setError('')
    setOpenSetting(null)
    setPickerOpen(true)
  }

  function addAssetToPrompt(job: Job, asset: Job['assets'][number]) {
    if (job.kind === 'video') {
      extendFrom(job)
    } else {
      const selected = kind === 'image' ? editImages : images
      const limit = kind === 'image' || imageMode === 'references' ? 3 : imageMode === 'frames' ? 2 : 4
      if (!selected.some((item) => item.assetId === asset.id)) {
        if (selected.length >= limit) {
          setError(`Choose up to ${limit} images for this prompt.`)
          return
        }
        if (kind === 'image') startEdit(job, asset.id)
        else selectImage(job, asset.id)
      }
    }
    setPickerOpen(false)
  }

  async function saveCrop(file: Blob) {
    if (!cropImage) return
    const job = await uploadStudioImage(file, projectId, cropImage.assetId)
    setJobs((previous) => [job, ...previous])
    setCropImage(null)
  }

  // Brings back the prompt, its settings, and the images, clip and characters it was made with.
  async function reusePrompt(job: Job) {
    switchKind(job.kind)
    setImages([])
    setImageMode('separate')
    setSource(null)
    setEditImages([])
    setPromptCharacters([])
    const modelAvailable = me.pricing.some((model) => model.model_key === job.modelKey)
    setParams(modelAvailable ? job.params : DEFAULTS[job.kind])
    setPrompt(job.promptOriginal)
    setCheck(null)
    setError('')
    if (!job.hasInputs) return
    try {
      const inputs = await api<ReuseInputs>(`/jobs/${job.id}/inputs`)
      if (inputs.editImages.length) setEditImages(inputs.editImages)
      if (inputs.images?.items.length) {
        setImages(inputs.images.items)
        setImageMode(inputs.images.mode)
      }
      if (inputs.source) setSource(inputs.source)
      setPromptCharacters(inputs.characterIds)
      if (inputs.missing) setError(`${inputs.missing} item${inputs.missing > 1 ? 's' : ''} this prompt used ${inputs.missing > 1 ? 'are' : 'is'} in the Bin or deleted, so ${inputs.missing > 1 ? 'they were' : 'it was'} left out.`)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // Uploads to the project's gallery; returns the uploads that worked and the problems shown.
  async function uploadFiles(files: File[]) {
    const uploaded: Job[] = []
    const errors: string[] = []
    if (!files.length) return { uploaded, errors }
    setUploading(true)
    setError('')
    try {
      for (const file of files) {
        if (!UPLOAD_TYPES.includes(file.type)) {
          errors.push(`${file.name || 'That file'}: use a PNG, JPEG or WebP image`)
          continue
        }
        try {
          const job = await uploadStudioImage(file, projectId)
          setJobs((previous) => [job, ...previous])
          uploaded.push(job)
        } catch (err) {
          errors.push(`${file.name || 'Image'}: ${(err as Error).message}`)
        }
      }
    } finally {
      setUploading(false)
    }
    if (errors.length) setError(errors.join(' · '))
    return { uploaded, errors }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    await uploadFiles(files)
  }

  // Pasted or dropped images: upload them and put them in the prompt, like choosing them from "+".
  async function addFilesToPrompt(files: File[]) {
    if (busy !== null) return
    const { uploaded, errors } = await uploadFiles(files)
    const picked = uploaded.flatMap((job) => job.assets[0] ? [{ jobId: job.id, assetId: job.assets[0].id, url: job.assets[0].url }] : [])
    if (!picked.length) return
    const editing = kind === 'image'
    const selected = editing ? editImages : images
    const limit = editing || imageMode === 'references' ? 3 : imageMode === 'frames' ? 2 : 4
    const room = Math.max(0, limit - selected.length)
    const added = picked.filter((item) => !selected.some((s) => s.assetId === item.assetId)).slice(0, room)
    if (added.length < picked.length) setError([...errors, `Up to ${limit} images fit this prompt, so ${picked.length - added.length} ${picked.length - added.length > 1 ? 'were' : 'was'} only saved to the gallery.`].join(' · '))
    if (!added.length) return
    setSource(null)
    setCheck(null)
    if (editing) {
      if (!editImages.length) setParams({ ...params, count: 1 })
      setImages([])
      setEditImages((previous) => [...previous, ...added])
    } else {
      setEditImages([])
      setImages((previous) => [...previous, ...added])
      if (imageMode === 'references') selectReferenceModel()
      if (imageMode === 'frames') selectFramesModel()
    }
  }

  // @ mentions: typing @ lists the project's images and videos and your characters; picking one
  // writes @Name in the prompt and adds it, the same as choosing it from "+".
  const promptBox = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<{ query: string; start: number; end: number } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  function findMention(box: HTMLTextAreaElement) {
    const caret = box.selectionStart
    if (caret !== box.selectionEnd) return setMention(null)
    const match = box.value.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,40})$/)
    if (!match) return setMention(null)
    if (mention?.query !== match[1]) setMentionIndex(0)
    setMention({ query: match[1], start: caret - match[1].length - 1, end: caret })
  }
  const mentionOptions: MentionOption[] = !mention ? [] : (() => {
    const query = mention.query.toLocaleLowerCase()
    const people: MentionOption[] = characters.map((character) => ({ key: `c${character.id}`, label: character.name, kind: 'character', thumb: character.images[0]?.url, character }))
    const media: MentionOption[] = jobs.filter((job) => job.status === 'succeeded')
      .flatMap((job) => job.assets.map((asset) => ({
        key: `a${asset.id}`, label: asset.name ?? `${job.kind}${asset.id}`, kind: job.kind, named: !!asset.name,
        thumb: asset.url, video: job.kind === 'video' && asset.mime.startsWith('video'), job, asset,
      } satisfies MentionOption)))
    const all = [...people, ...media.filter((item) => item.named), ...media.filter((item) => !item.named)]
    return all.filter((item) => item.label.toLocaleLowerCase().includes(query)).slice(0, 8)
  })()

  function pickMention(option: MentionOption) {
    if (!mention) return
    const token = `@${option.label} `
    const next = prompt.slice(0, mention.start) + token + prompt.slice(mention.end).replace(/^ /, '')
    setPrompt(next)
    setCheck(null)
    setMention(null)
    const caret = mention.start + token.length
    requestAnimationFrame(() => { promptBox.current?.focus(); promptBox.current?.setSelectionRange(caret, caret) })
    if (option.character) {
      if (!promptCharacters.includes(option.character.id)) toggleCharacter(option.character)
    } else if (option.job && option.asset) {
      addAssetToPrompt(option.job, option.asset)
    }
  }

  function mentionKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention || !mentionOptions.length) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setMentionIndex((index) => (index + step + mentionOptions.length) % mentionOptions.length)
      return true
    }
    if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'Tab') {
      event.preventDefault()
      pickMention(mentionOptions[Math.min(mentionIndex, mentionOptions.length - 1)])
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setMention(null)
      return true
    }
    return false
  }

  function pastedImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
    if (!files.length) return
    event.preventDefault()
    void addFilesToPrompt(files)
  }

  // Files dragged from the desktop or another app; drags inside the page (scene clips) are left alone.
  const dragDepth = useRef(0)
  const [dropping, setDropping] = useState(false)
  const modalOpen = pickerOpen || cropImage !== null || editingCharacter !== null
  const carriesFiles = (event: DragEvent) => !modalOpen && event.dataTransfer.types.includes('Files')
  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      dragDepth.current++
      setDropping(true)
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDropping(false)
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDropping(false)
      void addFilesToPrompt(Array.from(event.dataTransfer.files))
    },
  }

  async function upscale(job: Job, resolution: NonNullable<Params['resolution']>) {
    setUpscaling(job.id)
    setError('')
    try {
      const created = await api<Job>(`/jobs/${job.id}/upscale`, { resolution })
      setJobs((previous) => [created, ...previous])
      await refreshMe()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUpscaling(null)
    }
  }

  function changeImageMode(mode: ImageMode) {
    if (mode === 'references' && images.length > 3) {
      setError('Remove one image to use Veo’s three-image reference mode.')
      return
    }
    if (mode === 'frames' && images.length > 2) {
      setError('Keep two images: the first starts the video, the second ends it.')
      return
    }
    setImageMode(mode)
    setError('')
    if (mode === 'references') selectReferenceModel()
    if (mode === 'frames') selectFramesModel()
  }

  // Each selected image shows its role; the roles together pick the mode the server gets:
  // all Start = a video per image · Start + End = one video between them · all Ingredient = one video.
  function imageRole(index: number): ImageRole {
    if (imageMode === 'references') return 'ingredient'
    if (imageMode === 'frames') return index === 1 ? 'end' : 'start'
    return 'start'
  }

  function roleAllowed(role: ImageRole) {
    if (role === 'end') return images.length === 2
    if (role === 'ingredient') return images.length <= 3
    return true
  }

  function setImageRole(index: number, role: ImageRole) {
    if (role === imageRole(index)) return
    if (role === 'ingredient') return changeImageMode('references')
    if (role === 'end') {
      // The end image goes second; the other image becomes the start.
      if (index === 0) setImages((previous) => [...previous].reverse())
      if (imageMode !== 'frames') changeImageMode('frames')
      return
    }
    // Start: in Start → End this swaps the two; from Ingredients every image becomes a start.
    if (imageMode === 'frames') setImages((previous) => [...previous].reverse())
    else changeImageMode('separate')
  }

  // Start and end frames work on Veo 3.1 Quality and Fast; Fast is the cheaper one.
  function selectFramesModel() {
    setParams((previous) => {
      const supported = me.pricing.find((model) => model.model_key === previous.modelKey)?.caps?.endFrameDuration
      if (supported) return previous
      // Stay on Omni when an Omni model was chosen; otherwise the cheaper Veo.
      return canEditVideo(previous.modelKey) ? { ...previous, modelKey: EDIT_MODEL } : { ...previous, modelKey: 'veo-3.1-fast', durationSeconds: 8 }
    })
  }

  function selectReferenceModel() {
    setParams((previous) => {
      const supported = me.pricing.find((model) => model.model_key === previous.modelKey)?.caps?.referenceDuration
      return supported ? previous : { ...previous, modelKey: 'veo-3.1', durationSeconds: 8 }
    })
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- characters as references need a model that takes them
    if (characterReferences) selectReferenceModel()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when that changes
  }, [characterReferences])

  // No push channel in the MVP: poll running jobs; each poll also moves them forward on the server.
  useEffect(() => {
    const t = setInterval(async () => {
      const running = jobsRef.current.filter((j) => j.status === 'running' || j.status === 'reserved')
      if (!running.length) return
      const updated = await Promise.all(running.map((j) => api<Job>(`/jobs/${j.id}`).catch(() => j)))
      const finished = updated.some((u) => u.status !== 'running' && u.status !== 'reserved')
      setJobs((prev) => prev.map((p) => updated.find((u) => u.id === p.id) ?? p))
      if (finished) refreshMe()
    }, 2500)
    return () => clearInterval(t)
  }, [refreshMe])

  useEffect(() => {
    const t = setTimeout(async () => {
      // The server prices one video; "×N" and "video per image" multiply it.
      const takes = kind === 'video' ? params.count ?? 1 : 1
      try { setCost((await api<{ credits: number }>('/estimate', params)).credits * (imageMode === 'separate' ? Math.max(1, images.length) : 1) * takes) } catch { setCost(null) }
    }, 150)
    return () => clearTimeout(t)
  }, [params, images.length, imageMode, kind])

  // What the chosen video model accepts (from the server): resolutions, lengths, Auto.
  const capsOf = (key: string) => me.pricing.find((m) => m.model_key === key)?.caps
  const caps = kind === 'video' ? capsOf(params.modelKey) : undefined
  const framesMax = usesFrames && typeof caps?.endFrameDuration === 'object' ? caps.endFrameDuration.max : Infinity
  const maxSeconds = Math.min(caps ? (source ? caps.seconds.maxFromSource : caps.seconds.max) : 15, framesMax)
  const editing = source?.mode === 'edit'
  const videoCount = kind === 'video' ? params.count ?? 1 : 1
  const referenceDuration = usesReferences ? caps?.referenceDuration : undefined
  const fullLength = typeof referenceDuration === 'number' || (usesFrames && typeof caps?.endFrameDuration === 'number') || (!!caps && !!params.resolution && caps.fullLengthOnly.includes(params.resolution))

  // Keep every choice valid for the model, e.g. Veo has no 360p, no Auto, and lengths 4/6/8.
  const fit = useCallback((p: Params): Params => {
    const c = me.pricing.find((m) => m.model_key === p.modelKey)?.caps
    if (!c) return p
    const next = { ...p }
    if (!next.resolution || !c.resolutions.includes(next.resolution)) next.resolution = c.resolutions.includes('720p') ? '720p' : c.resolutions[0]
    if (next.aspectRatio === 'auto' && !c.autoAspect) next.aspectRatio = '16:9'
    const max = source ? c.seconds.maxFromSource : c.seconds.max
    const { min, step } = c.seconds
    let s = Math.round(((next.durationSeconds ?? max) - min) / step) * step + min
    s = Math.min(Math.max(s, min), max)
    if (c.fullLengthOnly.includes(next.resolution)) s = max
    if (usesReferences && typeof c.referenceDuration === 'number') s = c.referenceDuration
    if (usesFrames && typeof c.endFrameDuration === 'number') s = c.endFrameDuration
    if (usesFrames && typeof c.endFrameDuration === 'object') s = Math.min(s, c.endFrameDuration.max)
    // An edit keeps the clip's length.
    if (source?.mode === 'edit') s = Math.round(clipSeconds(source.job))
    next.durationSeconds = s
    return next
  }, [me.pricing, source, usesReferences, usesFrames])
  const set = (patch: Partial<Params>) => setParams((p) => fit({ ...p, ...patch }))
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-fit when a source is picked or dropped
    if (kind === 'video') setParams((p) => fit(p))
  }, [kind, fit])
  const switchKind = (k: Kind) => {
    if (k === kind) return
    setKind(k)
    setParams(DEFAULTS[k])
    setSource(null)
    setEditImages([])
    setImages([])
    setImageMode('separate')
    setCheck(null)
  }

  async function generate() {
    if (busy !== null || !prompt.trim() || !enough || !withinToday || !enoughReferences) return
    setOpenSetting(null)
    setBusy('generate')
    setError('')
    // Show a card right away: the content check and job setup take a few seconds.
    setPending({ prompt, kind, count: (images.length && imageMode === 'separate' ? images.length : 1) * videoCount })
    const editsMedia = editImages.length > 0 || source?.mode === 'edit'
    // The server accepts a check for 30 minutes; a kept one is checked again before that.
    const reuse = check && Date.now() - checkedAt.current < 25 * 60 * 1000 ? check : null
    try {
      const checked = reuse ?? await api<Check>('/prompt/check', { prompt, editImage: editsMedia })
      if (!reuse) checkedAt.current = Date.now()
      const checkedPrompt = reuse ? finalPrompt : checked.enhancedPrompt
      setCheck(checked)
      setFinalPrompt(checkedPrompt)
      // The content policy still runs on every Generate; a blocked prompt stops here at no cost.
      // "Review" matches still generate, and the job is marked Needs review for the admin.
      if (!checked.allowed || !checkedPrompt.trim()) return
      const request = {
        checkId: checked.checkId, finalPrompt: checkedPrompt, params,
        editImages: editImages.length ? editImages.map(({ jobId, assetId }) => ({ jobId, assetId })) : undefined,
        sourceJobId: source && source.mode !== 'edit' ? source.job.id : undefined, sourceAssetId: source?.assetId,
        editVideoJobId: source?.mode === 'edit' ? source.job.id : undefined,
        sceneId: kind === 'video' ? scene?.id : undefined,
        projectId,
        characterIds: promptCharacters.length ? promptCharacters : undefined,
      }
      const created = images.length
        ? await api<Job[]>('/jobs/from-images', {
          ...request,
          images: { mode: imageMode, items: images.map(({ jobId, assetId }) => ({ jobId, assetId })) },
        })
        : await api<Job[]>('/jobs', request)
      setJobs((prev) => [...created].reverse().concat(prev))
      setPending(null)
      // Keeping the prompt keeps everything it was made with (text, characters, images, start
      // frame or video), so you can make more takes; the passed check is reused while it's valid.
      if (!keepPrompt) {
        setPrompt('')
        setPromptCharacters([])
        setCheck(null)
        setSource(null)
        setEditImages([])
        setImages([])
        setImageMode('separate')
      }
      if (kind === 'video' && scene) updateScene(await api<Scene>(`/scenes/${scene.id}`))
      await refreshMe()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPending(null)
      setBusy(null)
    }
  }

  const models = me.pricing.filter((p) => p.kind === kind && (!usesReferences || p.caps?.referenceDuration !== undefined) && (!usesFrames || !!p.caps?.endFrameDuration) && (!editing || canEditVideo(p.model_key)))
  const modelPrice = (m: (typeof models)[number]) => m.kind === 'video' ? `${m.credits_per_second} cr/s` : `${m.credits_per_image} cr/image`
  const left = me.allowance.remaining
  const enough = cost == null || cost <= me.balance
  const withinToday = cost == null || left == null || cost <= left
  const modelLabel = models.find((model) => model.model_key === params.modelKey)?.label ?? params.modelKey

  // Settings chips: every model of this kind is listed; ones that can't do the current job are greyed with why.
  const showRes = (r: string) => r === '4k' ? '4K' : r
  const settingModels = me.pricing.filter((p) => p.kind === kind).map((p) => {
    const c = p.caps
    const blocked = usesReferences && c?.referenceDuration === undefined ? 'No Ingredients'
      : usesFrames && !c?.endFrameDuration ? 'No end frame'
      : editing && !canEditVideo(p.model_key) ? 'Can’t edit video' : null
    const tags = p.kind !== 'video' || !c ? [] : [
      c.resolutions.length > 1 ? `${showRes(c.resolutions[0])}–${showRes(c.resolutions[c.resolutions.length - 1])}` : showRes(c.resolutions[0]),
      `${c.seconds.min}–${c.seconds.max}s`,
      ...(c.endFrameDuration ? ['Start → End'] : []),
      ...(c.referenceDuration !== undefined ? ['Ingredients'] : []),
      ...(canEditVideo(p.model_key) ? ['Edit video'] : []),
    ]
    return { key: p.model_key, label: p.label, price: modelPrice(p), tags, blocked }
  })
  const showAspect = editImages.length === 0
  const aspectOptions = caps?.autoAspect ? ['auto', '16:9', '9:16'] as const : ['16:9', '9:16'] as const
  const lengthOptions: number[] = []
  if (caps) for (let s = caps.seconds.min; s <= maxSeconds; s += caps.seconds.step) lengthOptions.push(s)
  const lengthLocked = fullLength || editing
  const lengthNote = editing ? 'An edit keeps the clip’s length.'
    : typeof referenceDuration === 'number' ? `Ingredients on this model make ${referenceDuration}-second clips.`
    : usesFrames && typeof caps?.endFrameDuration === 'number' ? `Start → End on this model is ${caps.endFrameDuration} seconds.`
    : fullLength ? `${showRes(params.resolution ?? '')} is ${params.durationSeconds} seconds only on this model.`
    : source && caps && caps.seconds.maxFromSource < caps.seconds.max ? `Up to ${maxSeconds} seconds when continuing a clip.`
    : 'Only the lengths this model can make.'
  const formatLabel = kind === 'video'
    ? `${params.aspectRatio === 'auto' ? 'Auto' : params.aspectRatio} · ${showRes(params.resolution ?? '720p')} · ${params.durationSeconds ?? 4}s`
    : params.aspectRatio === 'auto' ? 'Auto' : params.aspectRatio
  const showFormat = kind === 'video' || showAspect
  const showCount = !(kind === 'video' && editing)
  const countValue = kind === 'video' ? videoCount : params.count ?? 1
  const currentCollection = collections.find((item) => item.id === activeCollection)
  const collectionLoading = activeCollection !== null && collectionMedia?.id !== activeCollection
  const inBin = mediaFilter === 'bin'
  const inFavorites = mediaFilter === 'favorites' && activeCollection === null
  const currentJobs = inBin ? bin?.jobs ?? [] : activeCollection !== null ? (collectionMedia?.id === activeCollection ? collectionMedia.jobs : [])
    : inFavorites ? favoriteJobs ?? [] : jobs
  const kindFilter = mediaFilter === 'image' || mediaFilter === 'video' || mediaFilter === 'uploads' ? mediaFilter : 'all'
  const visibleJobs = currentJobs.filter((job) => (inBin || kindFilter === 'all' || (kindFilter === 'uploads' ? job.modelKey === 'upload' : job.kind === kindFilter)) &&
    `${job.promptOriginal} ${job.promptFinal ?? ''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const listedCollections = inBin ? bin?.collections ?? [] : activeCollection === null && mediaFilter === 'all' && layout === 'grid' ? collections : []
  const visibleCollections = listedCollections.filter((item) => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const galleryItems = visibleJobs.flatMap((job) => layout === 'grid' && job.kind === 'image' && job.status === 'succeeded' && job.assets.length > 1
    ? job.assets.map((asset) => ({ key: 'asset-' + asset.id, job: { ...job, assets: [asset] } }))
    : [{ key: 'job-' + job.id, job }])
  const canGenerate = !!prompt.trim() && busy === null && enough && withinToday &&
    enoughReferences && (!check?.allowed || !!finalPrompt.trim())

  const showPending = !!pending && !inBin && activeCollection === null && (kindFilter === 'all' || kindFilter === pending.kind) && !inFavorites
  const tile = (j: Job, key: string, compact = false) => (
    <Tile key={key} job={j} grid={layout === 'grid'} compact={compact} inBin={inBin} onTrash={moveAssetToBin} onDismiss={dismissJob} onRestore={(id) => restoreFromBin('assets', id)} onExtend={extendInNewScene} onAnimate={selectImage} onEdit={startEdit} onCrop={(job, asset) => setCropImage({ jobId: job.id, assetId: asset.id, url: asset.url })} editImageIds={editImages.map((item) => item.assetId)} collections={collections} activeCollection={activeCollection} onCollectionChange={changeCollectionAsset} onReuse={reusePrompt} onUpscale={upscale} upscaling={upscaling} selectedImageIds={images.map((item) => item.assetId)} onNewScene={(job) => newScene([job.id]).catch((err) => setError(err.message))}
      onEditVideo={editVideo} editingVideoId={source?.mode === 'edit' ? source.job.id : null} onSaveFrame={saveFrame} savingFrame={savingFrame}
      onFavorite={setFavorite} onRename={renameAsset} onUpscaleImage={upscaleImage} upscalingImage={upscalingImage} imageUpscale={me.imageUpscale} />
  )
  // Batch view: the jobs from one press of Generate share a row, like Flow.
  const batches = visibleJobs.reduce<Job[][]>((groups, job) => {
    const last = groups[groups.length - 1]
    if (last && last[0].batchId === job.batchId) last.push(job)
    else groups.push([job])
    return groups
  }, [])
  const galleryCards = [
    ...(showPending ? Array.from({ length: layout === 'batch' ? 1 : pending.count }, (_, i) => <PendingTile key={'pending-' + i} prompt={pending.prompt} kind={pending.kind} count={layout === 'batch' ? pending.count : 1} />) : []),
    ...visibleCollections.map((item) => (
                    inBin ? <div key={item.id} className="scene-card bin-collection"><span>{item.name}</span>
                      <button className="btn sm secondary" onClick={() => restoreFromBin('collections', item.id)}>Restore collection</button>
                    </div> : <button key={item.id} className="scene-card" onClick={() => openCollection(item.id)}>{item.name}</button>
                  )),
    ...(layout === 'batch'
      ? batches.map((group) => group.length === 1 ? tile(group[0], 'job-' + group[0].id)
        : <BatchRow key={'batch-' + group[0].batchId} jobs={group} inBin={inBin} onReuse={reusePrompt}>{group.map((j) => tile(j, 'job-' + j.id, true))}</BatchRow>)
      : galleryItems.map(({ job: j, key }) => tile(j, key))),
  ]

  if (projectMissing) {
    return (
      <main className="home">
        <div className="empty">This project doesn’t exist or isn’t yours.
          <div><button className="btn sm secondary" style={{ marginTop: 12 }} onClick={() => navigate('/')}>Go to Home</button></div>
        </div>
      </main>
    )
  }

  const sceneMissing = view.sceneId != null && !scene

  return (
    <div ref={workspace} className={`studio${me.mock ? ' with-banner' : ''}${scene ? ' scene-open' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`} {...dropHandlers}>
      {dropping && <div className="drop-overlay" aria-hidden="true"><span>Drop images to add them to your prompt · سيب الصور هنا</span></div>}
      {pickerOpen && <AssetPicker jobs={jobs} uploading={uploading} error={error} onUpload={upload}
        onAdd={addAssetToPrompt} onClose={() => setPickerOpen(false)} />}
      {cropImage && <CropImage url={cropImage.url} onSave={saveCrop} onClose={() => setCropImage(null)} />}
      {editingCharacter !== null && <CharacterEditor character={editingCharacter === 'new' ? null : editingCharacter} jobs={jobs}
        uploading={uploading} onUpload={upload} onClose={() => setEditingCharacter(null)}
        onSaved={(saved) => {
          setCharacters((list) => list.some((item) => item.id === saved.id) ? list.map((item) => item.id === saved.id ? saved : item) : [...list, saved])
          setEditingCharacter(null)
        }} />}
      {!scene && (
        <div className="flow-toolbar">
          {project && <input className="project-title" aria-label="Project name" maxLength={80} dir="auto"
            key={project.id + ':' + project.name} defaultValue={project.name} title="Rename project"
            onBlur={(event) => { const value = event.target.value; event.target.value = value.trim() || project.name; void renameProject(value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />}
          <label className="flow-search">
            <span aria-hidden="true">⌕</span>
            <input type="search" aria-label="Search project" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div className="seg flow-view" role="group" aria-label="View">
            <button className={layout === 'batch' ? 'on' : ''} aria-pressed={layout === 'batch'} title="Batch view: each Generate in one row, with its details"
              onClick={() => setLayout('batch')}><span aria-hidden="true">☰</span> Batch</button>
            <button className={layout === 'grid' ? 'on' : ''} aria-pressed={layout === 'grid'} title="Grid view"
              onClick={() => setLayout('grid')}><span aria-hidden="true">▦</span> Grid</button>
          </div>
        </div>
      )}
      {!scene && (
        <nav className="flow-sidebar" aria-label="Project navigation">
          {ASSET_CATEGORIES.map(({ id, icon, label }) => (
            <button key={id} title={label} aria-label={label} aria-pressed={activeCollection === null && mediaFilter === id}
              onClick={() => go({ filter: id })}>
              <span aria-hidden="true">{icon}</span><b>{label}</b>
            </button>
          ))}
          <button title="Favorites" aria-label="Favorites" aria-pressed={activeCollection === null && mediaFilter === 'favorites'} onClick={() => go({ filter: 'favorites' })}>
            <span aria-hidden="true">★</span><b>Favorites</b>
          </button>
          <button title="Scenes" aria-label="Scenes" aria-pressed={mediaFilter === 'scenes'} onClick={() => go({ filter: 'scenes' })}>
            <span aria-hidden="true">▤</span><b>Scenes</b>
          </button>
          <button title="Characters" aria-label="Characters" aria-pressed={mediaFilter === 'characters'} onClick={() => go({ filter: 'characters' })}>
            <span aria-hidden="true">☺</span><b>Characters</b>
          </button>
          <div className="flow-sidebar-library">
            <div className="flow-library-heading">
              <button title="Library" aria-label="Library" aria-expanded={collectionsOpen} onClick={() => {
                if (sidebarCollapsed) { setSidebarCollapsed(false); setCollectionsOpen(true) }
                else setCollectionsOpen((open) => !open)
              }}><span aria-hidden="true">▱</span><b>Library</b></button>
              <button className="collection-create" title="New collection" aria-label="New collection" disabled={creatingCollection}
                onClick={() => createCollection()}>＋</button>
              <span className="collection-chevron" aria-hidden="true">{collectionsOpen ? '⌃' : '⌄'}</span>
            </div>
            {collectionsOpen && collections.map((item) => (
              <button key={item.id} className="collection-link" title={item.name} aria-pressed={activeCollection === item.id}
                onClick={() => openCollection(item.id)}>
                <span className="collection-icon" aria-hidden="true" /><b>{item.name}</b>
              </button>
            ))}
          </div>
          <button title="Bin" aria-label="Bin" aria-pressed={inBin} onClick={showBin}><span aria-hidden="true">♲</span><b>Bin</b></button>
          <button className="sidebar-collapse" title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}>
            <span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span><b>Collapse</b>
          </button>
        </nav>
      )}
      <section className="media-area" aria-label={scene ? 'Scene workspace' : inBin ? 'Bin' : currentCollection?.name ?? 'Project results'}>
        {scene ? (
          <SceneBuilder
            scene={scene}
            jobs={jobs}
            onChange={updateScene}
            onClose={() => { setSource(null); loadScenes(); go({ filter: 'scenes' }) }}
            onDeleted={() => { setScenes((prev) => prev.filter((x) => x.id !== scene.id)); setSource(null); go({ filter: 'scenes' }) }}
            onExtend={extendFrom}
            extendingFrom={source?.mode === 'extend' ? source.job.id : null}
          />
        ) : sceneMissing ? (
          <div className="empty">{scenesLoaded ? 'This scene was deleted or isn’t in this project.' : 'Loading…'}</div>
        ) : mediaFilter === 'characters' ? (
          <CharacterList characters={characters.filter((item) => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))}
            inPrompt={promptCharacters} onToggle={toggleCharacter} onEdit={(item) => setEditingCharacter(item ?? 'new')} onDelete={deleteCharacter} />
        ) : mediaFilter === 'scenes' ? (
          <div className="flow-scene-list">
            <button className="scene-card" onClick={() => newScene().catch((err) => setError(err.message))}>＋ New scene</button>
            {scenes.filter((item) => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map((item) => (
              <button key={item.id} className="scene-card" onClick={() => go({ sceneId: item.id })}>
                <span>{item.name}</span>
                <small>{item.clips.length} clips · {clock(item.clips.reduce((sum, clip) => sum + clipSeconds(clip.job), 0))}</small>
              </button>
            ))}
          </div>
        ) : (
          <>
            {currentCollection && <div className="collection-toolbar">
              <input className="collection-name" aria-label="Collection name" maxLength={80}
                key={currentCollection.id + ':' + currentCollection.name} defaultValue={currentCollection.name}
                onBlur={(event) => { const value = event.target.value; event.target.value = value.trim() || currentCollection.name; void renameCollection(currentCollection, value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
              <button className="btn sm secondary bin-action" onClick={() => moveCollectionToBin(currentCollection.id)}>Delete collection</button>
            </div>}
            {collectionLoading || (inBin && bin === null) || (inFavorites && favoriteJobs === null) ? <div className="empty">Loading…</div> : (
              galleryCards.length === 0 ? <div className="empty">
                {search.trim() ? 'No matching results.' : inBin ? 'The Bin is empty.' : currentCollection ? 'No media in this collection yet.'
                  : inFavorites ? 'No favorites yet. Press ☆ on an image or video to keep it here.' : 'Your images and videos will appear here.'}
              </div> : layout === 'grid' ? <GalleryColumns cards={galleryCards} /> : <div className="media-grid flow-batch">{galleryCards}</div>
            )}
          </>
        )}
      </section>

      <aside className="panel">
        <div className="panel-body" ref={panelBody}>
          {scene && kind === 'video' && (
            <div className="notice info small">
              <span>New videos go into <b>{scene.name}</b>{source?.mode === 'extend' ? ', right after the clip they continue' : ', at the end'}.</span>
            </div>
          )}
          {editImages.length > 0 && (
            <div className="field">
              <span>{editImages.length > 1 ? 'Reference images' : 'Image to edit'}</span>
              {editImages.map((image, index) => (
                <div className="source-chip" key={image.assetId}>
                  <img src={image.url} alt="" />
                  <span className="spacer">Image {index + 1}</span>
                  <button className="icon-btn" disabled={busy !== null} aria-label={`Remove image ${index + 1}`}
                    onClick={() => { setEditImages((previous) => previous.filter((item) => item.assetId !== image.assetId)); setCheck(null) }}>✕</button>
                </div>
              ))}
              {editImages.length < 3 && <span className="small muted">Choose Edit / combine on more images to use them together.</span>}
            </div>
          )}
          {source && (
            <div className="source-chip">
              {source.mode === 'animate' || !source.job.assets[0]?.mime.startsWith('video')
                ? <img src={(source.job.assets.find((a) => a.id === source.assetId) ?? source.job.assets[0])?.url} alt="" />
                : <video src={`${source.job.assets[0].url}#t=${source.mode === 'edit' ? 0.5 : Math.max(clipSeconds(source.job) - 0.2, 0)}`} muted preload="metadata" />}
              <div className="col" style={{ flex: 1, minWidth: 0 }}>
                <span className="strong small">{source.mode === 'extend' ? 'Extend · starts from the last frame' : source.mode === 'edit' ? `Edit this video · ${clock(clipSeconds(source.job))}` : 'Animate this image'}</span>
                <span className="faint small one-line" dir="auto">{source.job.promptOriginal}</span>
                <span className="faint small">{source.mode === 'extend' ? 'Write what happens next.' : source.mode === 'edit' ? 'Describe the change. Omni keeps the rest of the shot.' : 'Write how it should move.'}</span>
              </div>
              <button className="icon-btn" title="Don’t start from this" onClick={() => setSource(null)}>✕</button>
            </div>
          )}

          {chosenCharacters.length > 0 && (
            <div className="field">
              <span>Characters</span>
              {chosenCharacters.map((item) => (
                <div className="source-chip" key={item.id}>
                  {item.images[0] ? <img src={item.images[0].url} alt="" /> : <span className="character-blank" aria-hidden="true">☺</span>}
                  <div className="col" style={{ flex: 1, minWidth: 0 }}>
                    <span className="strong small" dir="auto">{item.name}</span>
                    {kind === 'video' && item.voice && <span className="faint small one-line" dir="auto">Voice · {item.voice}</span>}
                  </div>
                  <button className="icon-btn" aria-label={`Remove ${item.name}`} onClick={() => toggleCharacter(item)}>✕</button>
                </div>
              ))}
              <span className="small muted">
                {kind === 'image' ? 'Their images go to the model as references, with their description.'
                  : characterReferences || (images.length > 0 && imageMode === 'references') ? 'Their images go to the model as references (Omni or Veo 3.1 Quality), with their look and voice.'
                  : 'Only their look and voice are added to the prompt, since this video starts from a picture or clip.'}
              </span>
            </div>
          )}

          {kind === 'video' && images.length > 0 && (
            <div className="field">
              <span>Selected images</span>
              {images.map((item, index) => {
                const role = imageRole(index)
                return (
                  <div className="source-chip" key={item.assetId}>
                    <img src={item.url} alt="" />
                    <span className="spacer">Image {index + 1}</span>
                    <div className="seg role-seg" role="group" aria-label={`Use of image ${index + 1}`}>
                      {(['start', 'end', 'ingredient'] as const).map((option) => (
                        <button key={option} type="button" aria-pressed={role === option} className={role === option ? 'on' : ''}
                          disabled={role !== option && !roleAllowed(option)} title={ROLE_HELP[option]}
                          onClick={() => setImageRole(index, option)}>{ROLE_LABEL[option]}</button>
                      ))}
                    </div>
                    <button className="icon-btn" type="button" aria-label={`Remove image ${index + 1}`}
                      onClick={() => setImages((previous) => previous.filter((image) => image.assetId !== item.assetId))}>✕</button>
                  </div>
                )
              })}
              {imageMode === 'separate' && <span className="small muted">{images.length > 1 ? `Each image starts its own video (${images.length} videos). Mark one image End to make one video between two images, or use them all as Ingredients in one video.` : 'The video starts on this image. Add a second image to end on it, or use images as Ingredients.'}</span>}
              {usesFrames && <span className="small muted">{images.length === 2 ? 'The video starts on the Start image and ends on the End image.' : 'Choose a second image for where the video ends.'} {typeof caps?.endFrameDuration === 'object' ? `Up to ${caps.endFrameDuration.max} seconds on this model.` : `Omni 1.2, Veo 3.1 Quality or Fast. ${caps?.endFrameDuration ?? 8} seconds on Veo.`}</span>}
              {usesReferences && <span className="small muted">{characterImages ? 'Up to 3 reference images, counting the characters’ images.' : 'Select 2–3 reference images.'}{typeof referenceDuration === 'number' ? ` This model generates an ${referenceDuration}-second clip.` : ''}</span>}
            </div>
          )}

          {check && !check.allowed && (
            <div className="notice danger">
              <div className="col" style={{ gap: 8, flex: 1 }}>
                <span className="strong">This prompt can’t be generated</span>
                {check.reasonAr && <span className="small rtl">{check.reasonAr}</span>}
                <span className="small muted">{check.reasonEn} Nothing was generated and no credits were used.</span>
                {check.rules.map((r) => <span key={r.id} className="small">Rule · {r.name}</span>)}
                {check.safeAlternative && (
                  <div className="suggestion" style={{ background: 'var(--bg-raised)' }}>
                    <span className="label">You could make this instead</span>
                    <span className="small">{check.safeAlternative}</span>
                    <button className="btn sm secondary" style={{ alignSelf: 'flex-start' }} onClick={() => { setPrompt(check.safeAlternative); setCheck(null) }}>Use this prompt</button>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div className="error-text">{error}</div>}
        </div>

        <div className="panel-foot" ref={composerDock}>
          <div className="composer">
            {mention && (
              <div className="mention-list" role="listbox" aria-label="Mention an image, video or character">
                {mentionOptions.length ? mentionOptions.map((option, index) => (
                  <button key={option.key} type="button" role="option" aria-selected={index === mentionIndex}
                    className={index === mentionIndex ? 'on' : ''} onMouseDown={(event) => { event.preventDefault(); pickMention(option) }}
                    onMouseEnter={() => setMentionIndex(index)}>
                    {option.video ? <video src={option.thumb} muted preload="metadata" /> : option.thumb ? <img src={option.thumb} alt="" /> : <span className="mention-icon">☺</span>}
                    <span className="mention-name">@{option.label}</span>
                    <span className="faint small">{option.kind === 'character' ? 'Character' : option.kind === 'video' ? 'Video' : 'Image'}{option.kind !== 'character' && !option.named ? ' · no name yet' : ''}</span>
                  </button>
                )) : <div className="faint small mention-empty">Nothing called “{mention.query}”. Name an image or video with ✎ Name to mention it.</div>}
              </div>
            )}
            <textarea
              ref={promptBox}
              dir="auto"
              disabled={busy !== null}
              placeholder={editImages.length > 1 ? 'How should these images be combined? · عايز تجمع الصور إزاي؟' : editImages.length === 1 ? 'What should change? · عايز تعدّل إيه في الصورة؟' : source?.mode === 'extend' ? 'What happens next? · إيه اللي يحصل بعد كده؟' : source?.mode === 'edit' ? 'Describe how to edit this video · عايز تعدّل إيه في الفيديو؟' : 'What do you want to create? · اكتب اللي عايز تعمله'}
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setCheck(null); findMention(e.target) }}
              onPaste={pastedImages}
              onClick={(e) => findMention(e.currentTarget)}
              onBlur={() => setMention(null)}
              onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') findMention(e.currentTarget) }}
              onKeyDown={(e) => {
                if (mentionKeys(e)) return
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void generate() }
              }}
            />
            {uploading && !modalOpen && <span className="faint small composer-uploading">Uploading image…</span>}
            {openSetting === 'model' && (
              <div className="setting-pop" role="dialog" aria-label="Model">
                <div className="setting-pop-head"><span className="setting-label">Model</span>
                  <span className="faint small">{kind === 'video' ? 'Price per second at 720p' : 'Price per image'}</span></div>
                <div className="setting-models">
                  {settingModels.map((m) => (
                    <button key={m.key} type="button" className={`setting-model${m.key === params.modelKey ? ' on' : ''}`} aria-pressed={m.key === params.modelKey}
                      disabled={!!m.blocked} title={m.blocked ?? undefined} onClick={() => { set({ modelKey: m.key }); setOpenSetting(null) }}>
                      <span className="setting-model-copy">
                        <b>{m.label}</b>
                        {(m.tags.length > 0 || m.blocked) && (
                          <span className="setting-tags">
                            {m.blocked && <span className="setting-tag warn">{m.blocked}</span>}
                            {m.tags.map((tag) => <span className="setting-tag" key={tag}>{tag}</span>)}
                          </span>
                        )}
                      </span>
                      <span className="faint small">{m.price}</span>
                      <span className="setting-check" aria-hidden="true">{m.key === params.modelKey ? '✓' : ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {openSetting === 'format' && showFormat && (
              <div className="setting-pop setting-pop-format" role="dialog" aria-label="Format">
                {showAspect && (
                  <div className="setting-group">
                    <span className="setting-label">Aspect ratio</span>
                    <div className="setting-opts">
                      {aspectOptions.map((a) => (
                        <button key={a} type="button" className={params.aspectRatio === a ? 'on' : ''} aria-pressed={params.aspectRatio === a}
                          title={a === 'auto' ? 'Let the model choose the shape' : undefined} onClick={() => set({ aspectRatio: a })}>{a === 'auto' ? 'Auto' : a}</button>
                      ))}
                    </div>
                  </div>
                )}
                {kind === 'video' && (
                  <>
                    <div className="setting-group">
                      <span className="setting-label">Resolution</span>
                      <div className="setting-opts">
                        {(caps?.resolutions ?? ['720p']).map((r) => (
                          <button key={r} type="button" className={params.resolution === r ? 'on' : ''} aria-pressed={params.resolution === r}
                            onClick={() => set({ resolution: r })}>{showRes(r)}</button>
                        ))}
                      </div>
                    </div>
                    <div className="setting-group">
                      <span className="setting-label">Length</span>
                      <div className="setting-opts setting-lengths">
                        {lengthOptions.map((n) => (
                          <button key={n} type="button" className={params.durationSeconds === n ? 'on' : ''} aria-pressed={params.durationSeconds === n}
                            disabled={lengthLocked && params.durationSeconds !== n} onClick={() => set({ durationSeconds: n })}>{n}s</button>
                        ))}
                      </div>
                      <span className="faint small">{lengthNote}</span>
                    </div>
                  </>
                )}
              </div>
            )}
            {openSetting === 'count' && showCount && (
              <div className="setting-pop setting-pop-count" role="dialog" aria-label={kind === 'video' ? 'Videos' : 'Images'}>
                <span className="setting-label">{kind === 'video' ? 'Videos' : 'Images'}</span>
                <div className="setting-opts">
                  {[1, 2, 3, 4].map((n) => (
                    <button key={n} type="button" className={countValue === n ? 'on' : ''} aria-pressed={countValue === n}
                      onClick={() => { set({ count: n }); setOpenSetting(null) }}>×{n}</button>
                  ))}
                </div>
                <span className="faint small">Each one is charged.</span>
              </div>
            )}
            <div className="flow-composer-actions">
              <button className="icon-btn" type="button" title="Add media to prompt" aria-label="Add media to prompt"
                disabled={busy !== null} onClick={openLibrary}><span aria-hidden="true">+</span></button>
              <div className="kind-seg" role="group" aria-label="Make a video or an image">
                <button type="button" className={kind === 'video' ? 'on' : ''} aria-pressed={kind === 'video'} disabled={busy !== null}
                  onClick={() => { switchKind('video'); setOpenSetting(null) }}>Video</button>
                <button type="button" className={kind === 'image' ? 'on' : ''} aria-pressed={kind === 'image'} disabled={busy !== null}
                  onClick={() => { switchKind('image'); setOpenSetting(null) }}>Image</button>
              </div>
              <button type="button" className={`setting-chip${openSetting === 'model' ? ' open' : ''}`} data-setting="model"
                aria-expanded={openSetting === 'model'} disabled={busy !== null} onClick={() => toggleSetting('model')}>
                <span className="setting-chip-text">{modelLabel}</span><span aria-hidden="true">⌄</span>
              </button>
              {showFormat && (
                <button type="button" className={`setting-chip${openSetting === 'format' ? ' open' : ''}`} data-setting="format"
                  aria-expanded={openSetting === 'format'} aria-label={`Format: ${formatLabel}`} disabled={busy !== null} onClick={() => toggleSetting('format')}>
                  <span className="setting-chip-text">{formatLabel}</span><span aria-hidden="true">⌄</span>
                </button>
              )}
              <div className="spacer" />
              {showCount && (
                <button type="button" className={`setting-chip${openSetting === 'count' ? ' open' : ''}`} data-setting="count"
                  aria-expanded={openSetting === 'count'} aria-label={`${countValue} ${kind === 'video' ? 'video' : 'image'}${countValue > 1 ? 's' : ''}`}
                  disabled={busy !== null} onClick={() => toggleSetting('count')}>×{countValue}</button>
              )}
              <button className="flow-generate" aria-label={cost == null ? 'Generate' : `Generate, about ${fmt(cost)} credits`} title="Generate (Ctrl+Enter)"
                disabled={!canGenerate} onClick={() => generate()}>
                <span className="num">{cost == null ? '…' : `≈ ${fmt(cost)}`}</span>
                <span className="flow-generate-arrow" aria-hidden="true">{busy === 'generate' ? <span className="flow-spinner" /> : '→'}</span>
              </button>
            </div>
            <div className="flow-credit-line small num">
              <label className="keep-prompt small" title="Keep the prompt after Generate, to make more takes of it">
                <input type="checkbox" checked={keepPrompt} onChange={(event) => setKeepPrompt(event.target.checked)} />
                Keep prompt
              </label>
              {characters.length > 0 && (
                <select className="collection-add composer-characters" aria-label="Add a character to the prompt" value="" disabled={busy !== null}
                  onChange={(event) => { const item = characters.find((c) => c.id === Number(event.target.value)); if (item) toggleCharacter(item) }}>
                  <option value="">☺ Character</option>
                  {characters.filter((item) => !promptCharacters.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              )}
              <span>{left != null ? `${fmt(left)} left today` : `${fmt(me.balance)} left`}</span>
              {isArabic(prompt) && <span>Arabic · translated word for word</span>}
              <span className="flow-disclaimer">AI can make mistakes</span>
            </div>
          </div>
          {!enough && <span className="error-text">Not enough credits. Request more from Usage &amp; credits.</span>}
          {enough && !withinToday && <span className="error-text">That’s more than the {fmt(left ?? 0)} credits left of today’s limit. Request more for today from Usage &amp; credits, or wait until midnight.</span>}

        </div>
      </aside>
    </div>
  )
}

function GalleryColumns({ cards }: { cards: ReactElement[] }) {
  const gallery = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(1)

  useLayoutEffect(() => {
    const element = gallery.current
    if (!element) return
    // Match the 280px minimum card width and 12px gutter used by the gallery.
    const resize = () => setCount(Math.max(1, Math.floor((element.clientWidth + 12) / 292)))
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A card keeps its column once placed. Placing by position would move every card when a new
  // one is added at the top, and a moved card is rebuilt (a playing video starts over).
  const [placed, setPlaced] = useState<{ count: number; columns: Map<string, number> }>({ count: 0, columns: new Map() })
  const known = placed.count === count ? placed.columns : new Map<string, number>()
  const sizes = Array.from({ length: count }, () => 0)
  for (const card of cards) {
    const column = known.get(String(card.key))
    if (column !== undefined) sizes[column]++
  }
  const assigned = new Map<string, number>()
  const columns: ReactElement[][] = Array.from({ length: count }, () => [])
  for (const card of cards) {
    const key = String(card.key)
    let column = known.get(key)
    if (column === undefined) {
      column = sizes.indexOf(Math.min(...sizes))
      sizes[column]++
    }
    assigned.set(key, column)
    columns[column].push(card)
  }
  useLayoutEffect(() => {
    const same = placed.count === count && assigned.size === placed.columns.size &&
      [...assigned].every(([key, column]) => placed.columns.get(key) === column)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- remember where new cards went
    if (!same) setPlaced({ count, columns: assigned })
  })

  return (
    <div className="media-grid flow-grid" ref={gallery} style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {columns.map((column, index) => <div className="flow-grid-column" key={index}>{column}</div>)}
    </div>
  )
}

type TileProps = {
  job: Job
  grid: boolean
  inBin: boolean
  onTrash: (assetId: number) => Promise<void>
  onDismiss: (jobId: number) => void
  onRestore: (assetId: number) => Promise<void>
  onExtend: (job: Job) => void
  onAnimate: (job: Job, assetId: number) => void
  onEdit: (job: Job, assetId: number) => void
  onCrop: (job: Job, asset: Job['assets'][number]) => void
  editImageIds: number[]
  collections: Collection[]
  activeCollection: number | null
  onCollectionChange: (id: number, assetId: number, add: boolean) => Promise<void>
  onReuse: (job: Job) => void
  onUpscale: (job: Job, resolution: NonNullable<Params['resolution']>) => void
  upscaling: number | null
  selectedImageIds: number[]
  onNewScene: (job: Job) => void
  // Inside a batch row: the row shows the prompt and details, so the tile doesn't.
  compact?: boolean
  onEditVideo: (job: Job) => void
  editingVideoId: number | null
  onSaveFrame: (job: Job, seconds: number) => void
  savingFrame: number | null
  onFavorite: Favorite
  onRename: Rename
  onUpscaleImage: (assetId: number, size: '2K' | '4K') => void
  upscalingImage: number | null
  imageUpscale: { size: '2K' | '4K'; credits: number }[]
}

// Names an image or video so it can be mentioned in a prompt with @.
function NameButton({ asset, onRename }: { asset: Job['assets'][number]; onRename: Rename }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  if (!editing) {
    return (
      <button className="btn sm secondary name-btn" title={asset.name ? `Mention it in a prompt as @${asset.name}. Click to rename.` : 'Name it to mention it in a prompt with @'}
        onClick={() => { setValue(asset.name ?? ''); setEditing(true) }}>
        {asset.name ? `@${asset.name}` : '✎ Name'}
      </button>
    )
  }
  const save = () => {
    setEditing(false)
    if (value.trim() !== (asset.name ?? '')) void onRename(asset.id, value)
  }
  return (
    <input className="name-input" autoFocus maxLength={40} value={value} placeholder="Name, e.g. Ahmed" aria-label="Name for @ mentions"
      onChange={(event) => setValue(event.target.value.replace(/@/g, ''))} onBlur={save}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); save() }
        if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
      }} />
  )
}

function FavoriteButton({ asset, onFavorite }: { asset: Job['assets'][number]; onFavorite: Favorite }) {
  return (
    <button className={`btn sm secondary favorite-btn${asset.favorite ? ' on' : ''}`} aria-pressed={asset.favorite}
      title={asset.favorite ? 'Remove from Favorites' : 'Add to Favorites'} onClick={() => onFavorite(asset.id, !asset.favorite)}>
      {asset.favorite ? '★ Favorite' : '☆ Favorite'}
    </button>
  )
}

// One press of Generate in batch view: its takes side by side, with the shared details beside them.
function BatchRow({ jobs, inBin, onReuse, children }: { jobs: Job[]; inBin: boolean; onReuse: (job: Job) => void; children: ReactElement[] }) {
  const first = jobs[jobs.length - 1]
  const running = jobs.filter((job) => job.status === 'running' || job.status === 'reserved').length
  const credits = jobs.reduce((sum, job) => sum + (job.status === 'failed' ? 0 : job.actualCost ?? job.estimatedCost), 0)
  const p = first.params
  return (
    <div className="batch-row">
      <div className="batch-takes">{children}</div>
      <div className="batch-details">
        <span className="prompt" dir="auto">{first.promptOriginal}</span>
        <div className="row small faint num">
          <span>{jobs.length} {first.kind}s</span>
          {first.kind === 'video' && <><span>·</span><span>{p.durationSeconds}s · {p.resolution} · {p.aspectRatio}</span></>}
        </div>
        <div className="row small faint num">
          <span>{first.modelKey}</span><span>·</span><span>{credits} cr</span>
          {running > 0 && <><span>·</span><span>{running} generating</span></>}
          <div className="spacer" />
          <span>{timeAgo(first.createdAt)}</span>
        </div>
        {!inBin && running === 0 && first.promptOriginal && <button className="btn sm secondary" onClick={() => onReuse(first)}>Reuse prompt</button>}
      </div>
    </div>
  )
}

// Stands in for a new job while its prompt is checked and the job is created.
function PendingTile({ prompt, kind, count }: { prompt: string; kind: Kind; count: number }) {
  return (
    <div className="tile running pending" aria-busy="true">
      <div className="media skeleton">
        <span className="small muted">Checking prompt · starting {count > 1 ? `${count} ${kind}s` : kind}…</span>
      </div>
      <div className="foot">
        <span className="prompt" dir="auto">{prompt}</span>
        <span className="skeleton-line" />
      </div>
    </div>
  )
}

function Tile({ job, grid, inBin, onTrash, onDismiss, onRestore, onExtend, onAnimate, onEdit, onCrop, editImageIds, collections, activeCollection, onCollectionChange, onReuse, onUpscale, upscaling, selectedImageIds, onNewScene, compact = false, onEditVideo, editingVideoId, onSaveFrame, savingFrame, onFavorite, onRename, onUpscaleImage, upscalingImage, imageUpscale }: TileProps) {
  const [now, setNow] = useState(() => Date.now())
  const videoRef = useRef<HTMLVideoElement>(null)
  const running = job.status === 'running' || job.status === 'reserved'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const label = job.kind === 'video' ? `${job.params.durationSeconds}s · ${job.params.resolution} · ${job.params.aspectRatio}`
    : job.params.upscale ? `Upscaled ${job.params.upscale.startsWith('x') ? job.params.upscale.replace('x', '×') : `to ${job.params.upscale}`}`
    : `${job.assets.length || job.params.count} image${(job.assets.length || job.params.count) > 1 ? 's' : ''}`
  const safety = job.error?.startsWith('safety')

  function collectionActions(assetId: number) {
    if (activeCollection !== null) return <button className="btn sm secondary" onClick={() => onCollectionChange(activeCollection, assetId, false)}>Remove from collection</button>
    if (!collections.length) return null
    return (
      <select className="collection-add" aria-label="Add to collection" value="" onChange={(event) => {
        if (event.target.value) void onCollectionChange(Number(event.target.value), assetId, true)
      }}>
        <option value="">Add to collection</option>
        {collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    )
  }

  function imageActions(asset: Job['assets'][number]) {
    if (inBin) return <div className="image-actions"><button className="btn sm secondary" onClick={() => onRestore(asset.id)}>Restore image</button></div>
    return (
      <div className="image-actions">
        <FavoriteButton asset={asset} onFavorite={onFavorite} />
        <NameButton asset={asset} onRename={onRename} />
        <button className="btn sm secondary" aria-pressed={selectedImageIds.includes(asset.id)} onClick={() => onAnimate(job, asset.id)}>
          {selectedImageIds.includes(asset.id) ? '✓ Selected' : '＋ Use in video'}
        </button>
        <button className="btn sm secondary" aria-pressed={editImageIds.includes(asset.id)} onClick={() => onEdit(job, asset.id)}>
          {editImageIds.includes(asset.id) ? '✓ In prompt' : 'Edit / combine'}
        </button>
        <button className="btn sm secondary" onClick={() => onCrop(job, asset)}>Crop</button>
        <select className="collection-add" aria-label="Upscale this image" value="" disabled={upscalingImage !== null}
          onChange={(event) => { if (event.target.value) onUpscaleImage(asset.id, event.target.value as '2K' | '4K') }}>
          <option value="">{upscalingImage === asset.id ? 'Upscaling…' : 'Upscale'}</option>
          {imageUpscale.map(({ size, credits }) => <option key={size} value={size}>To {size} · {credits} cr</option>)}
        </select>
        <a className="btn sm secondary" href={asset.url} download>Download</a>
        {collectionActions(asset.id)}
        <button className="btn sm secondary bin-action" onClick={() => onTrash(asset.id)}>Delete image</button>
      </div>
    )
  }

  const ready = job.status === 'succeeded' && job.assets.length > 0
  const videoReady = ready && job.kind === 'video'

  return (
    <div className={`tile ${running ? 'running' : ''} ${job.status === 'failed' ? 'failed' : ''}${job.modelKey === 'upload' ? ' uploaded' : ''}${ready && !inBin ? ' ready' : ''}`}>
      <div className={job.kind === 'image' && job.status === 'succeeded' ? 'media image-media' : 'media'}>
        {running && (
          <div className="col" style={{ alignItems: 'center', gap: 10 }}>
            <span className="strong">Generating · {Math.max(0, Math.round((now - job.createdAt) / 1000))}s</span>
            <div className="progress"><i /></div>
            <span className="faint small">Video usually takes 1–2 minutes · {job.estimatedCost} credits reserved</span>
          </div>
        )}
        {job.status === 'failed' && (
          <div className="col" style={{ alignItems: 'center', gap: 6, padding: 16, textAlign: 'center' }}>
            <span className="strong">Couldn’t make this {job.kind}</span>
            <span className="small muted">{safety ? 'Google’s safety check stopped it' : job.error} · {job.estimatedCost} credits refunded</span>
            {!inBin && <button className="btn sm ghost bin-action" onClick={() => onDismiss(job.id)}>Remove</button>}
          </div>
        )}
        {job.status === 'succeeded' && job.kind === 'video' && job.assets[0] && (
          job.assets[0].mime.startsWith('video')
            ? <>
              <video ref={videoRef} src={job.assets[0].url} controls preload="metadata" playsInline />
              {!inBin && (
                <button className="frame-btn" title="Save the frame you’re on as an image" disabled={savingFrame !== null}
                  onClick={() => onSaveFrame(job, videoRef.current?.currentTime ?? 0)}>
                  {savingFrame === job.id ? 'Saving…' : '⧉ Save frame'}
                </button>
              )}
            </>
            : <img src={job.assets[0].url} alt="" />
        )}

        {job.status === 'succeeded' && job.kind === 'image' && (
          <div className={`imgs ${job.assets.length === 1 ? 'one' : ''}`}>
            {job.assets.map((a) => (
              <div key={a.id} className="img-cell">
                <a className="image-preview" href={a.url} target="_blank" rel="noreferrer" aria-label="Open image preview"><img src={a.url} alt="" /></a>
                {!grid && imageActions(a)}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="foot">
        {grid && ready && job.kind === 'image' && imageActions(job.assets[0])}
        {!compact && <>
          <span className="prompt" dir="auto">{job.promptOriginal}</span>
          <div className="row small faint num">
            <span>{label}</span>
            <span>·</span>
            <span>{job.modelKey === 'upload' ? 'upload' : job.status === 'failed' ? 'refunded' : `${job.actualCost ?? job.estimatedCost} cr`}</span>
            {job.needsReview && <span className="badge warn">Needs review</span>}
            {job.assets[0]?.mock && <span className="badge">mock</span>}
            <div className="spacer" />
            <span>{timeAgo(job.createdAt)}</span>
          </div>
          {!inBin && !running && job.modelKey !== 'upload' && job.promptOriginal && !videoReady && (
            <button className="btn sm secondary" onClick={() => onReuse(job)}>Reuse prompt</button>
          )}
        </>}
        {inBin && job.kind === 'video' && job.assets[0] && <button className="btn sm secondary" onClick={() => onRestore(job.assets[0].id)}>Restore video</button>}
        {!inBin && videoReady && (
          <>
            {/* What you do next with a clip, most used first. */}
            <div className="row tile-actions">
              <button className="btn sm extend-action" title="Make the next shot, starting from this clip's last frame" onClick={() => onExtend(job)}>＋ Extend</button>
              <button className="btn sm secondary" aria-pressed={editingVideoId === job.id} title="Change this video with a prompt (Omni)" onClick={() => onEditVideo(job)}>
                {editingVideoId === job.id ? '✓ Editing' : 'Edit video'}
              </button>
              <button className="btn sm secondary" title="Start a scene timeline with this clip" onClick={() => onNewScene(job)}>Add to scene</button>
              {!compact && job.promptOriginal && <button className="btn sm secondary" onClick={() => onReuse(job)}>Reuse prompt</button>}
            </div>
            <div className="row tile-actions tile-more">
              {!!job.upscaleOptions?.length && (
                <select className="collection-add" aria-label="Upscale this video" value="" disabled={upscaling !== null}
                  onChange={(event) => {
                    const option = job.upscaleOptions?.find((item) => item.resolution === event.target.value)
                    if (option) onUpscale(job, option.resolution)
                  }}>
                  <option value="">{upscaling === job.id ? 'Starting upscale…' : 'Upscale'}</option>
                  {job.upscaleOptions.map(({ resolution, credits }) => (
                    <option key={resolution} value={resolution}>To {resolution === '4k' ? '4K' : resolution} · {credits} cr</option>
                  ))}
                </select>
              )}
              <FavoriteButton asset={job.assets[0]} onFavorite={onFavorite} />
              <NameButton asset={job.assets[0]} onRename={onRename} />
              {collectionActions(job.assets[0].id)}
              <button className="btn sm ghost bin-action" onClick={() => onTrash(job.assets[0].id)}>Delete</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
