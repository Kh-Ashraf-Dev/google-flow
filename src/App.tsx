import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, fmt, type Me } from './api.ts'
import { Admin } from './pages/Admin.tsx'
import { Home } from './pages/Home.tsx'
import { Login } from './pages/Login.tsx'
import { Studio } from './pages/Studio.tsx'
import { Usage } from './pages/Usage.tsx'

// What a project page shows. Each one has its own URL, so Back/Forward and refresh work.
export type StudioFilter = 'all' | 'image' | 'video' | 'uploads' | 'favorites' | 'scenes' | 'bin' | 'characters'
// clipId: a video opened on its own page (play, extend, edit, trim, upscale).
export type StudioView = { filter: StudioFilter; collectionId: number | null; sceneId: number | null; clipId?: number | null }

type Route =
  | { page: 'home' | 'usage' | 'admin' }
  | { page: 'project'; projectId: number; view: StudioView }

const FILTER_PATHS: Record<string, StudioFilter> = {
  '': 'all', images: 'image', videos: 'video', uploads: 'uploads', favorites: 'favorites', scenes: 'scenes', bin: 'bin', characters: 'characters',
}

export function studioPath(projectId: number, view: Partial<StudioView>) {
  const base = `/project/${projectId}`
  if (view.clipId != null) return `${base}/clip/${view.clipId}`
  if (view.sceneId != null) return `${base}/scene/${view.sceneId}`
  if (view.collectionId != null) return `${base}/collection/${view.collectionId}`
  const part = Object.entries(FILTER_PATHS).find(([, filter]) => filter === (view.filter ?? 'all'))?.[0] ?? ''
  return part ? `${base}/${part}` : base
}

function currentRoute(): Route {
  const p = window.location.pathname.replace(/\/+$/, '')
  if (p === '/usage' || p === '/admin') return { page: p.slice(1) as 'usage' | 'admin' }
  const m = /^\/project\/(\d+)(?:\/(scene|collection|clip)\/(\d+)|\/([a-z]+))?$/.exec(p)
  if (m) {
    const view: StudioView = { filter: 'all', collectionId: null, sceneId: null }
    if (m[2] === 'scene') { view.filter = 'scenes'; view.sceneId = Number(m[3]) }
    else if (m[2] === 'collection') view.collectionId = Number(m[3])
    else if (m[2] === 'clip') view.clipId = Number(m[3])
    else if (m[4]) view.filter = FILTER_PATHS[m[4]] ?? 'all'
    return { page: 'project', projectId: Number(m[1]), view }
  }
  return { page: 'home' }
}

export type Navigate = (path: string, options?: { replace?: boolean }) => void
export type AppProps = { me: Me; refreshMe: () => Promise<void>; navigate: Navigate }

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [route, setRoute] = useState<Route>(currentRoute)

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'))
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null)
      else throw err
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial session load
    refreshMe()
    const onPop = () => setRoute(currentRoute())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [refreshMe])

  const navigate: Navigate = useCallback((path, options) => {
    if (path !== window.location.pathname) {
      if (options?.replace) window.history.replaceState(null, '', path)
      else window.history.pushState(null, '', path)
    }
    setRoute(currentRoute())
  }, [])

  if (me === undefined) return null
  if (me === null) return <Login onDone={refreshMe} />

  const isAdmin = me.user.role === 'admin'
  const page = route.page === 'admin' && !isAdmin ? 'home' : route.page
  const initials = me.user.name.split(' ').map((p) => p[0]).join('').slice(0, 2)
  const signOut = async () => { await api('/logout', {}); setMe(null) }

  return (
    <>
      {me.mock && <div className="mock-banner">Mock mode: no Google calls, no money spent. Set VERTEX_KEY_FILE or VERTEX_KEY_JSON to use Vertex AI.</div>}
      <header className={page === 'project' ? 'topbar flow-header' : 'topbar'}>
        <button className="logo logo-link" title="Home: all projects" onClick={() => navigate('/')}>
          <img className="logo-img" src="/awqaf-logo.png" alt="The Ministry of Awqaf of Egypt" />
          <div>
            <b>Studio</b>
            <small>Ministry Media Office</small>
          </div>
        </button>
        {page === 'project' ? (
          <>
            <button className="btn sm secondary home-btn" onClick={() => navigate('/')}><span aria-hidden="true">⌂</span> Home</button>
            <details className="flow-account">
              <summary className="icon-btn" title="Studio menu" aria-label="Studio menu">⋮</summary>
              <div className="flow-menu">
                <button className="btn sm ghost" onClick={() => navigate('/usage')}>Usage &amp; credits</button>
                {isAdmin && <button className="btn sm ghost" onClick={() => navigate('/admin')}>Admin</button>}
                <button className="btn sm ghost" onClick={signOut}>Sign out</button>
              </div>
            </details>
          </>
        ) : (
          <nav className="nav">
            <a className={page === 'home' ? 'on' : ''} onClick={() => navigate('/')}>Projects</a>
            <a className={page === 'usage' ? 'on' : ''} onClick={() => navigate('/usage')}>Usage &amp; credits</a>
            {isAdmin && <a className={page === 'admin' ? 'on' : ''} onClick={() => navigate('/admin')}>Admin</a>}
          </nav>
        )}
        <div className="spacer" />
        <div className="credits-pill num" title="Your credit balance">
          <span>{fmt(me.balance)} credits</span>
        </div>
        <span className="badge">{isAdmin ? 'ADMIN' : me.user.department?.toUpperCase()}</span>
        <div className="avatar" title={me.user.email}>{initials}</div>
        {page !== 'project' && <button className="btn ghost sm" onClick={signOut}>Sign out</button>}
      </header>
      {page === 'home' && <Home navigate={navigate} />}
      {route.page === 'project' && <Studio key={route.projectId} me={me} refreshMe={refreshMe} navigate={navigate} projectId={route.projectId} view={route.view} />}
      {page === 'usage' && <Usage me={me} refreshMe={refreshMe} navigate={navigate} />}
      {page === 'admin' && <Admin me={me} refreshMe={refreshMe} navigate={navigate} />}
    </>
  )
}
