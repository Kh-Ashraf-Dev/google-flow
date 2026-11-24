import { useState, type FormEvent } from 'react'
import { api } from '../api.ts'

export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api('/login', { email, password })
      await onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="logo">
          <img className="logo-img lg" src="/awqaf-logo.png" alt="The Ministry of Awqaf of Egypt" />
          <div>
            <b>Studio</b>
            <small>Ministry Media Office</small>
          </div>
        </div>
        <div className="col">
          <h2>Sign in</h2>
          <span className="faint small">Use your Studio account. Personal Google accounts aren’t needed.</span>
        </div>
        <label className="field">
          <span>Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error-text">{error}</div>}
        <button className="btn" disabled={busy || !email || !password}>Sign in</button>
      </form>
    </div>
  )
}
