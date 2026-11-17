import { useCallback, useEffect, useState } from 'react'
import type { AppProps } from '../App.tsx'
import { api, fmt, timeAgo } from '../api.ts'

type Entry = { id: number; type: string; amount: number; reason: string | null; createdAt: number; jobId: number | null; prompt: string | null }
type Request = { id: number; amount: number; reason: string; status: 'pending' | 'approved' | 'denied'; decided_amount: number | null; created_at: number }

const TYPE_LABEL: Record<string, string> = {
  allocation: 'Added by admin', reserve: 'Generation', commit: 'Final cost', refund: 'Refund', topup: 'Top-up', adjustment: 'Correction',
}

export function Usage({ me, refreshMe }: AppProps) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [requests, setRequests] = useState<Request[]>([])
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    const [e, r] = await Promise.all([api<Entry[]>('/ledger'), api<Request[]>('/topups')])
    setEntries(e.filter((x) => !(x.type === 'commit' && x.amount === 0)))
    setRequests(r)
  }, [])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load
    load()
  }, [load])

  const pending = requests.find((r) => r.status === 'pending')
  const refunded = entries.filter((e) => e.type === 'refund').reduce((s, e) => s + e.amount, 0)

  return (
    <div className="page">
      <div className="page-head">
        <div className="col">
          <h1>Usage & credits</h1>
          <span className="faint small">Your credits are given by your admin. Failed or blocked generations never cost anything.</span>
        </div>
        <button className="btn" disabled={!!pending} onClick={() => setOpen(true)}>Request more credits</button>
      </div>

      {pending && (
        <div className="notice info">
          <span className="small">Your request for <b>+{fmt(pending.amount)} credits</b> is waiting for your admin · sent {timeAgo(pending.created_at)}</span>
        </div>
      )}

      <div className="stats">
        <div className="stat"><span className="faint small">Balance</span><span className="v num">{fmt(me.balance)}</span><span className="faint small">credits you can use</span></div>
        <div className="stat">
          <span className="faint small">Used today</span>
          <span className="v num">{fmt(me.allowance.spent)}{me.allowance.limit != null && <span className="faint" style={{ fontSize: 16 }}> / {fmt(me.allowance.limit + me.allowance.extra)}</span>}</span>
          {me.allowance.limit != null ? (
            <>
              <div className="meter"><i style={{ width: `${Math.min(100, (me.allowance.spent / (me.allowance.limit + me.allowance.extra)) * 100)}%` }} /></div>
              <span className="faint small">daily limit · resets at midnight{me.allowance.extra > 0 ? ` · +${fmt(me.allowance.extra)} approved today` : ''}</span>
            </>
          ) : <span className="faint small">no daily limit</span>}
        </div>
        <div className="stat"><span className="faint small">Refunded</span><span className="v num ok">{fmt(refunded)}</span><span className="faint small">from failed generations</span></div>
        <div className="stat"><span className="faint small">Requests</span><span className="v num">{requests.length}</span><span className="faint small">{requests.filter((r) => r.status === 'approved').length} approved</span></div>
      </div>

      <div className="grid-2">
        <div className="card tight">
          <h3 style={{ marginBottom: 10 }}>Activity</h3>
          <table className="table">
            <thead><tr><th>When</th><th>What</th><th>Details</th><th className="r">Credits</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="faint small num" style={{ whiteSpace: 'nowrap' }}>{timeAgo(e.createdAt)}</td>
                  <td>{TYPE_LABEL[e.type] ?? e.type}</td>
                  <td className="small muted" dir="auto" style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.prompt ?? e.reason}</td>
                  <td className={`r num ${e.amount > 0 ? 'ok' : ''}`}>{e.amount > 0 ? '+' : '−'}{fmt(Math.abs(e.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Price list</h3>
          {me.pricing.map((p) => (
            <div key={p.model_key} className="row">
              <span className="muted" style={{ flex: 1 }}>{p.label}</span>
              <span className="num">
                {p.kind === 'video' ? `${Math.ceil((p.credits_per_second ?? 0) * 8)} cr / 8s video` : `${p.credits_per_image} cr / image`}
              </span>
            </div>
          ))}
          <span className="faint small">1080p costs a little more. You always see the cost before you generate.</span>
          <h3 style={{ marginTop: 8 }}>My requests</h3>
          {requests.length === 0 && <span className="faint small">No requests yet.</span>}
          {requests.map((r) => (
            <div key={r.id} className="row">
              <div className="col" style={{ flex: 1, gap: 0 }}>
                <span className="num">+{fmt(r.decided_amount ?? r.amount)}</span>
                <span className="faint small" dir="auto">{r.reason}</span>
              </div>
              <span className={`badge ${r.status === 'approved' ? 'success' : r.status === 'denied' ? 'danger' : 'accent'}`}>{r.status}</span>
            </div>
          ))}
        </div>
      </div>

      {open && <RequestModal onClose={() => setOpen(false)} onSent={async () => { setOpen(false); await load(); await refreshMe() }} />}
    </div>
  )
}

function RequestModal({ onClose, onSent }: { onClose: () => void; onSent: () => Promise<void> }) {
  const [amount, setAmount] = useState(1000)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  async function send() {
    try {
      await api('/topups', { amount, reason })
      await onSent()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Request more credits</h2>
        <span className="small muted">Your admin gets your request. Once approved, the credits are added and your daily limit goes up by the same amount for today.</span>
        <div className="field">
          <span>How many?</span>
          <div className="seg full">
            {[500, 1000, 2000].map((n) => <button key={n} className={amount === n ? 'on' : ''} onClick={() => setAmount(n)}>+{fmt(n)}</button>)}
          </div>
        </div>
        <label className="field">
          <span>Reason</span>
          <textarea className="input" dir="auto" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What do you need them for?" />
        </label>
        {error && <div className="error-text">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={!reason.trim()} onClick={send}>Send request</button>
        </div>
      </div>
    </div>
  )
}
