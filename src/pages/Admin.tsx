import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AppProps } from '../App.tsx'
import { api, fmt, timeAgo, type Allowance, type Job } from '../api.ts'

type Overview = {
  pool: number
  spentToday: number
  googleUsdToday: number
  dailySpendCapUsd: number
  jobsToday: Record<string, number>
  departments: { id: number; name: string }[]
  users: { id: number; name: string; email: string; role: string; disabled: boolean; departmentId: number | null; balance: number; allowance: Allowance }[]
  requests: { id: number; user_id: number; name: string; department: string | null; amount: number; reason: string; created_at: number }[]
  jobs: Job[]
  audit: { id: number; action: string; details: string | null; createdAt: number; name: string | null }[]
}
type Report = {
  days: number
  total: number
  googleUsd: number
  teams: Record<string, number>
  people: { id: number; name: string; department: string | null; dailyLimit: number | null; credits: number; googleUsd: number; videos: number; images: number; failed: number; blocked: number; requests: number; lastActive: number | null }[]
}
type Policy = {
  rules: { id: number; name: string; description: string; action: 'block' | 'review'; active: number }[]
  keywords: { id: number; word: string }[]
}

const STATUS: Record<string, [string, string]> = {
  running: ['Running', 'accent'], reserved: ['Starting', 'accent'], succeeded: ['Done', 'success'], failed: ['Refunded', 'danger'], blocked: ['Blocked', 'danger'],
}

const ACTION: Record<string, string> = {
  'prompt.blocked': 'had a prompt blocked', 'job.created': 'started a generation', 'job.refunded': 'was refunded for a failed job',
  'topup.requested': 'requested credits', 'topup.approved': 'approved a credit request', 'topup.denied': 'denied a credit request',
  'credits.allocated': 'allocated credits', 'policy.keyword_added': 'added a blocked word', 'policy.keyword_removed': 'removed a blocked word',
  'policy.rule_on': 'turned a policy rule on', 'policy.rule_off': 'turned a policy rule off', login: 'signed in', seed: 'set up demo data',
  'user.created': 'created an employee account',
  'user.disabled': 'disabled an employee account',
  'user.enabled': 'reactivated an employee account',
  'user.department_changed': 'changed an account’s department',
  'user.password_reset': 'reset an employee password',
  'limit.changed': 'changed someone’s daily limit',
}

export function Admin({ refreshMe }: AppProps) {
  const [ov, setOv] = useState<Overview | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [days, setDays] = useState(7)
  const [amounts, setAmounts] = useState<Record<number, string>>({})
  const [word, setWord] = useState('')
  const [error, setError] = useState('')
  const [changingStatus, setChangingStatus] = useState<number | null>(null)
  const [resetUser, setResetUser] = useState<Overview['users'][number] | null>(null)
  const [passwordNotice, setPasswordNotice] = useState('')

  const load = useCallback(async () => {
    const [o, p, r] = await Promise.all([api<Overview>('/admin/overview'), api<Policy>('/admin/policy'), api<Report>(`/admin/report?days=${days}`)])
    setOv(o)
    setPolicy(p)
    setReport(r)
  }, [days])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    load()
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [load])

  async function act(fn: () => Promise<unknown>) {
    setError('')
    try {
      await fn()
      await Promise.all([load(), refreshMe()])
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function changeAccountStatus(user: Overview['users'][number]) {
    const disabled = !user.disabled
    if (disabled && !window.confirm(`Disable ${user.email}? This signs them out immediately.`)) return

    setChangingStatus(user.id)
    try {
      await act(() => api(`/admin/users/${user.id}/status`, { disabled }))
    } finally {
      setChangingStatus(null)
    }
  }

  if (!ov || !policy) return null
  const blocked = ov.jobsToday.blocked ?? 0
  const capPct = Math.min(100, (ov.googleUsdToday / ov.dailySpendCapUsd) * 100)

  return (
    <div className="page">
      <div className="page-head">
        <div className="col">
          <h1>Admin</h1>
          <span className="faint small">Ministry Media Office · {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </div>
      </div>
      {error && <div className="error-text">{error}</div>}

      <div className="stats">
        <div className="stat"><span className="faint small">Credit pool left</span><span className="v num">{fmt(ov.pool)}</span><span className="faint small">not yet given to anyone</span></div>
        <div className="stat"><span className="faint small">Credits used today</span><span className="v num">{fmt(ov.spentToday)}</span><span className="faint small">{(ov.jobsToday.succeeded ?? 0)} done · {(ov.jobsToday.failed ?? 0)} refunded</span></div>
        <div className="stat">
          <span className="faint small">Google cost today</span>
          <span className="v num">${ov.googleUsdToday.toFixed(2)}</span>
          <div className="meter"><i style={{ width: `${capPct}%`, background: capPct > 80 ? 'var(--danger)' : undefined }} /></div>
          <span className="faint small">daily cap ${ov.dailySpendCapUsd}</span>
        </div>
        <div className="stat"><span className="faint small">Blocked by policy today</span><span className={`v num ${blocked ? 'bad' : ''}`}>{blocked}</span><span className="faint small">no credits used</span></div>
      </div>

      <div className="grid-2">
        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="row"><h3>Credit requests</h3>{ov.requests.length > 0 && <span className="badge accent">{ov.requests.length}</span>}</div>
            {ov.requests.length === 0 && <span className="faint small">No pending requests.</span>}
            {ov.requests.map((r) => (
              <div key={r.id} className="row" style={{ gap: 12, borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
                <div className="avatar">{r.name.split(' ').map((p) => p[0]).join('')}</div>
                <div className="col" style={{ flex: 1, gap: 2 }}>
                  <span><span className="strong">{r.name}</span> <span className="faint small">· {r.department} · {timeAgo(r.created_at)}</span></span>
                  <span className="small muted" dir="auto">“{r.reason}”</span>
                </div>
                <input className="input num" style={{ width: 90 }} value={amounts[r.id] ?? String(r.amount)} onChange={(e) => setAmounts({ ...amounts, [r.id]: e.target.value })} />
                <button className="btn ghost sm" onClick={() => act(() => api(`/admin/topups/${r.id}/deny`, {}))}>Deny</button>
                <button className="btn sm" onClick={() => act(() => api(`/admin/topups/${r.id}/approve`, { amount: Number(amounts[r.id] ?? r.amount) }))}>Approve</button>
              </div>
            ))}
          </div>

          {report && (
            <div className="card tight">
              <div className="row" style={{ marginBottom: 10 }}>
                <div className="col" style={{ flex: 1, gap: 2 }}>
                  <h3>Who used what</h3>
                  <span className="faint small num">{fmt(report.total)} credits · ${report.googleUsd.toFixed(2)} Google cost · {Object.entries(report.teams).filter(([, v]) => v > 0).map(([t, v]) => `${t} ${fmt(v)}`).join(' · ') || 'no usage yet'}</span>
                </div>
                <div className="seg">
                  {[[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([d, l]) => (
                    <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d as number)}>{l}</button>
                  ))}
                </div>
              </div>
              <table className="table">
                <thead><tr><th>Person</th><th style={{ width: '32%' }}>Credits used</th><th className="r">Videos</th><th className="r">Images</th><th className="r">Refunded</th><th className="r">Blocked</th><th className="r">Last active</th></tr></thead>
                <tbody>
                  {report.people.map((p, i) => {
                    const top = report.people[0]?.credits || 1
                    return (
                      <tr key={p.id}>
                        <td><div className="col" style={{ gap: 0 }}><span className="strong">{p.name}</span><span className="faint small">{p.department}</span></div></td>
                        <td>
                          <div className="row">
                            <div className="meter" style={{ flex: 1 }}><i style={{ width: `${(p.credits / top) * 100}%`, background: i === 0 && p.credits > 0 ? 'var(--warn)' : undefined }} /></div>
                            <span className="num small" style={{ width: 52, textAlign: 'right' }}>{fmt(p.credits)}</span>
                          </div>
                        </td>
                        <td className="r num">{p.videos}</td>
                        <td className="r num">{p.images}</td>
                        <td className="r num">{p.failed}</td>
                        <td className={`r num ${p.blocked ? 'bad' : ''}`}>{p.blocked}</td>
                        <td className="r faint small num" style={{ whiteSpace: 'nowrap' }}>{p.lastActive ? timeAgo(p.lastActive) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <CreateAccount departments={ov.departments} onCreated={load} />

          <div className="card tight">
            <div className="col" style={{ gap: 2, marginBottom: 10 }}>
              <h3>People</h3>
              <span className="faint small">The daily limit caps how fast someone can spend. Approving a request lifts it for that day.</span>
            </div>
            {passwordNotice && <p className="small" role="status">{passwordNotice}</p>}
            {resetUser && (
              <ResetPassword key={resetUser.id} user={resetUser} onCancel={() => setResetUser(null)} onSaved={() => {
                setPasswordNotice(`Password updated for ${resetUser.email}.`)
                setResetUser(null)
                void load().catch(() => {})
              }} />
            )}
            <table className="table">
              <thead><tr><th>Name</th><th style={{ width: '26%' }}>Today</th><th className="r">Daily limit</th><th className="r">Balance</th><th className="r">Give credits</th><th className="r">Account</th></tr></thead>
              <tbody>
                {ov.users.map((u) => {
                  const a = u.allowance
                  const cap = a.limit == null ? null : a.limit + a.extra
                  const pct = cap ? Math.min(100, (a.spent / cap) * 100) : 0
                  return (
                    <tr key={u.id}>
                      <td><div className="col" style={{ gap: 0 }}><span className="strong">{u.name} {u.role === 'admin' && <span className="badge">admin</span>}{u.disabled && <span className="badge warn">Disabled</span>}</span><span className="faint small">{u.email}</span>
                        <DepartmentEditor key={u.departmentId ?? 'none'} user={u} departments={ov.departments}
                          onSave={(departmentId) => act(() => api(`/admin/users/${u.id}/department`, { departmentId }))} />
                      </div></td>
                      <td>
                        <div className="col" style={{ gap: 4 }}>
                          <span className="small num">{fmt(a.spent)}{cap != null ? ` / ${fmt(cap)}` : ''}{a.extra > 0 && <span className="faint"> (+{fmt(a.extra)} today)</span>}</span>
                          {cap != null && <div className="meter"><i style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--danger)' : pct > 80 ? 'var(--warn)' : undefined }} /></div>}
                        </div>
                      </td>
                      <td className="r"><Limit key={String(a.limit)} value={a.limit} onSave={(n) => act(() => api(`/admin/users/${u.id}/limit`, { limit: n }))} /></td>
                      <td className="r num">{fmt(u.balance)}</td>
                      <td className="r"><Allocate onGive={(n) => act(() => api('/admin/allocate', { userId: u.id, amount: n }))} /></td>
                      <td className="r">
                        {u.role === 'employee' && (
                          <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                            <button className="btn sm secondary" disabled={resetUser !== null} onClick={() => {
                              setPasswordNotice('')
                              setResetUser(u)
                            }}>
                              Reset password
                            </button>
                            <button className="btn sm secondary" disabled={changingStatus !== null} aria-label={`${u.disabled ? 'Reactivate' : 'Disable'} ${u.email}`} onClick={() => void changeAccountStatus(u)}>
                              {changingStatus === u.id ? 'Saving…' : u.disabled ? 'Reactivate' : 'Disable'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="card tight">
            <h3 style={{ marginBottom: 10 }}>Latest generations</h3>
            <table className="table">
              <thead><tr><th>Who</th><th>Prompt</th><th>Status</th><th className="r">Credits</th><th className="r">When</th></tr></thead>
              <tbody>
                {ov.jobs.map((j) => {
                  const [label, tone] = STATUS[j.status] ?? [j.status, '']
                  return (
                    <tr key={j.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{j.userName}</td>
                      <td className="small muted" dir="auto" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.promptOriginal}</td>
                      <td><span className={`badge ${tone}`}>{label}</span>{j.needsReview && <span className="badge warn" style={{ marginLeft: 4 }}>review</span>}</td>
                      <td className="r num">{j.status === 'blocked' ? '0' : j.status === 'failed' ? `↺ ${j.estimatedCost}` : (j.actualCost ?? j.estimatedCost)}</td>
                      <td className="r faint small num" style={{ whiteSpace: 'nowrap' }}>{timeAgo(j.createdAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="col" style={{ gap: 2 }}>
              <h3>Content policy</h3>
              <span className="faint small">Checked before every generation · blocked prompts never use credits</span>
            </div>
            {policy.rules.map((r) => (
              <div key={r.id} className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <div className="col" style={{ flex: 1, gap: 2 }}>
                  <span className={r.active ? 'strong' : 'strong faint'}>{r.name}</span>
                  <span className="faint small">{r.description}</span>
                </div>
                <span className={`badge ${r.action === 'block' ? 'danger' : 'warn'}`}>{r.action === 'block' ? 'Block' : 'Review'}</span>
                <button className={`toggle ${r.active ? 'on' : ''}`} aria-label={`Turn ${r.name} ${r.active ? 'off' : 'on'}`} onClick={() => act(() => api(`/admin/policy/rules/${r.id}`, { active: !r.active }))} />
              </div>
            ))}
          </div>

          <div className="card">
            <div className="col" style={{ gap: 2 }}>
              <h3>Blocked words</h3>
              <span className="faint small">Arabic and English · checked instantly, before the AI check</span>
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); if (word.trim()) act(async () => { await api('/admin/policy/keywords', { word }); setWord('') }) }}>
              <input className="input" dir="auto" placeholder="Add a word or phrase" value={word} onChange={(e) => setWord(e.target.value)} />
              <button className="btn sm secondary" disabled={!word.trim()}>Add</button>
            </form>
            <div className="chips">
              {policy.keywords.map((k) => (
                <span key={k.id} className="chip" dir="auto">{k.word}<button aria-label={`Remove ${k.word}`} onClick={() => act(() => api(`/admin/policy/keywords/${k.id}`, undefined, 'DELETE'))}>×</button></span>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>Audit log</h3>
            {ov.audit.map((a) => (
              <div key={a.id} className="row" style={{ alignItems: 'flex-start' }}>
                <span className="small" style={{ flex: 1 }}><span className="strong">{a.name ?? 'System'}</span> <span className="muted">{ACTION[a.action] ?? a.action}</span></span>
                <span className="faint small num" style={{ whiteSpace: 'nowrap' }}>{timeAgo(a.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function CreateAccount({ departments, onCreated }: { departments: Overview['departments']; onCreated: () => Promise<void> }) {
  const [credentialType, setCredentialType] = useState<'password' | 'bcrypt'>('password')
  const [limit, setLimit] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const importing = credentialType === 'bcrypt'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const email = String(fields.get('email')).trim()
    const departmentId = fields.get('departmentId')
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await api('/admin/users', {
        name: fields.get('name'),
        email,
        credentialType,
        credential: fields.get('credential'),
        departmentId: departmentId ? Number(departmentId) : null,
        limit: limit === '' ? null : Number(limit),
      })
      form.reset()
      setCredentialType('password')
      setLimit('')
      setSuccess(`Account created for ${email}.`)
      await onCreated().catch(() => setError('Account created. The people list could not refresh yet.'))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Add employee account</h3>
      <fieldset className="account-fields" disabled={saving}>
        <label className="field">
          <span>Name</span>
          <input className="input" name="name" dir="auto" required maxLength={120} />
        </label>
        <label className="field">
          <span>Email</span>
          <input className="input" name="email" type="email" required maxLength={254} />
        </label>
        <label className="field">
          <span>Department</span>
          <select className="input" name="departmentId">
            <DepartmentOptions departments={departments} />
          </select>
        </label>
        <label className="field">
          <span>Daily limit (credits)</span>
          <input className="input num" type="number" min={1} max={2147483647} step={1} placeholder="No limit" value={limit} onChange={(event) => setLimit(event.target.value)} />
          <small className="faint">{limit ? `≈ $${(Number(limit) * 0.08).toFixed(2)} per day in credits` : '500 credits ≈ $40'}</small>
        </label>
        <label className="field">
          <span>Password input</span>
          <select className="input" value={credentialType} onChange={(event) => setCredentialType(event.target.value === 'bcrypt' ? 'bcrypt' : 'password')}>
            <option value="password">New password</option>
            <option value="bcrypt">Existing bcrypt hash</option>
          </select>
        </label>
        <label className="field">
          <span>{importing ? 'bcrypt hash' : 'Password'}</span>
          <input key={credentialType} className="input" name="credential" type="password" autoComplete={importing ? 'off' : 'new-password'} required minLength={importing ? 60 : 8} maxLength={importing ? undefined : 72} />
        </label>
      </fieldset>
      <div className="row">
        <button className="btn" disabled={saving}>{saving ? 'Creating…' : 'Create account'}</button>
        {success && <span className="small" role="status">{success}</span>}
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
    </form>
  )
}

function ResetPassword({ user, onCancel, onSaved }: {
  user: Overview['users'][number]
  onCancel: () => void
  onSaved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const password = fields.get('password')
    if (password !== fields.get('confirmPassword')) {
      setError('The passwords must match.')
      return
    }

    setSaving(true)
    setError('')
    try {
      await api(`/admin/users/${user.id}/password`, { password })
      onSaved()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h4>Reset password for {user.email}</h4>
      <span className="faint small">Saving a new password signs this employee out of all sessions.</span>
      <fieldset className="account-fields" disabled={saving}>
        <label className="field">
          <span>New password</span>
          <input className="input" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />
        </label>
        <label className="field">
          <span>Confirm password</span>
          <input className="input" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />
        </label>
      </fieldset>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="row">
        <button className="btn sm" disabled={saving}>{saving ? 'Saving…' : 'Save password'}</button>
        <button className="btn sm secondary" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}

function DepartmentOptions({ departments }: { departments: Overview['departments'] }) {
  return <>
    <option value="">No department</option>
    {departments.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
  </>
}

function DepartmentEditor({ user, departments, onSave }: {
  user: Overview['users'][number]
  departments: Overview['departments']
  onSave: (departmentId: number | null) => Promise<void>
}) {
  const saved = user.departmentId?.toString() ?? ''
  const [value, setValue] = useState(saved)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    try {
      await onSave(value === '' ? null : Number(value))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="row" style={{ marginTop: 4 }} onSubmit={submit}>
      <select className="input" style={{ minHeight: 32, padding: '4px 8px' }} value={value} disabled={saving}
        aria-label={`Department for ${user.email}`} onChange={(event) => setValue(event.target.value)}>
        <DepartmentOptions departments={departments} />
      </select>
      {value !== saved && <button className="btn sm secondary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
    </form>
  )
}

function Limit({ value, onSave }: { value: number | null; onSave: (n: number | null) => void }) {
  const [v, setV] = useState(value == null ? '' : String(value))
  const changed = v !== (value == null ? '' : String(value))
  return (
    <form className="row" style={{ justifyContent: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); onSave(v.trim() ? Number(v) : null) }}>
      <input className="input num" style={{ width: 80, minHeight: 32, padding: '4px 8px' }} placeholder="No limit" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn sm secondary" disabled={!changed}>Set</button>
    </form>
  )
}

function Allocate({ onGive }: { onGive: (n: number) => void }) {
  const [v, setV] = useState('')
  return (
    <form className="row" style={{ justifyContent: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); const n = Number(v); if (n > 0) { onGive(n); setV('') } }}>
      <input className="input num" style={{ width: 80, minHeight: 32, padding: '4px 8px' }} placeholder="500" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn sm secondary" disabled={!(Number(v) > 0)}>Give</button>
    </form>
  )
}
