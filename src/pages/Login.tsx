import { useState, type FormEvent } from 'react'
import { api } from '../api.ts'

const DEMO = [
  ['Saif Sabry', 'saif@awqaf.demo', 'Employee · Media'],
  ['Mona Nabil', 'mona@awqaf.demo', 'Employee · Social'],
  ['Omar Khaled', 'omar@awqaf.demo', 'Admin · Media'],
]

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
        <div className="col">
          <span className="label">Demo accounts · password demo1234</span>
          <div className="demo-accounts">
            {DEMO.map(([name, mail, role]) => (
              <button type="button" key={mail} onClick={() => { setEmail(mail); setPassword('demo1234') }}>
                <div className="avatar">{name.split(' ').map((p) => p[0]).join('')}</div>
                <div className="col" style={{ gap: 0 }}>
                  <span className="strong">{name}</span>
                  <span className="faint small">{role}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  )
}
