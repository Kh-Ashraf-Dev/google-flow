// Home: every project, newest activity first. A project keeps its own media, scenes and collections.
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Navigate } from '../App.tsx'
import { api, timeAgo, type Project } from '../api.ts'

export function Home({ navigate }: { navigate: Navigate }) {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api<Project[]>('/projects').then(setProjects).catch((err: Error) => { setProjects([]); setError(err.message) })
  }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || creating) return
    setCreating(true)
    setError('')
    try {
      const project = await api<Project>('/projects', { name: name.trim() })
      navigate(`/project/${project.id}`)
    } catch (err) {
      setError((err as Error).message)
      setCreating(false)
    }
  }

  async function rename(project: Project, value: string) {
    setRenaming(null)
    const next = value.trim()
    if (!next || next === project.name) return
    try {
      const updated = await api<Project>(`/projects/${project.id}`, { name: next }, 'PATCH')
      setProjects((list) => list && list.map((item) => item.id === project.id ? updated : item))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <main className="home">
      <div className="home-head">
        <h1>Projects</h1>
        <form className="home-create" onSubmit={create}>
          <input className="input" aria-label="New project name" placeholder="New project name · اسم المشروع" maxLength={80} dir="auto"
            value={name} onChange={(event) => setName(event.target.value)} />
          <button className="btn" disabled={!name.trim() || creating}>{creating ? 'Creating…' : '＋ New project'}</button>
        </form>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      {projects === null ? <div className="empty">Loading…</div>
        : projects.length === 0 ? <div className="empty">No projects yet. Name your first project above to start.</div>
        : (
          <div className="project-grid">
            {projects.map((project) => (
              <div className="project-card" key={project.id}>
                <button className="project-open" onClick={() => navigate(`/project/${project.id}`)} aria-label={`Open ${project.name}`}>
                  <div className="project-cover">
                    {project.cover?.mime.startsWith('video/') ? <video src={`${project.cover.url}#t=0.5`} muted preload="metadata" />
                      : project.cover ? <img src={project.cover.url} alt="" />
                      : <span className="faint small">Empty project</span>}
                  </div>
                </button>
                <div className="project-meta">
                  {renaming === project.id ? (
                    <input className="input project-rename" aria-label="Project name" maxLength={80} dir="auto" autoFocus defaultValue={project.name}
                      onBlur={(event) => rename(project, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                        if (event.key === 'Escape') setRenaming(null)
                      }} />
                  ) : (
                    <div className="row">
                      <b className="project-name" dir="auto">{project.name}</b>
                      <div className="spacer" />
                      <button className="btn sm ghost" onClick={() => setRenaming(project.id)}>Rename</button>
                    </div>
                  )}
                  <span className="faint small num">{project.items} item{project.items === 1 ? '' : 's'} · {timeAgo(project.updatedAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
    </main>
  )
}
