import { db } from './db.ts'

export type EntryType = 'topup' | 'allocation' | 'reserve' | 'commit' | 'refund' | 'adjustment'

export class InsufficientCredits extends Error {}

export async function orgWalletId(): Promise<number> {
  return (await db.get<{ id: number }>("SELECT id FROM wallets WHERE owner_type = 'org'"))!.id
}

export async function userWalletId(userId: number): Promise<number> {
  const row = await db.get<{ id: number }>("SELECT id FROM wallets WHERE owner_type = 'user' AND owner_id = ?", userId)
  if (row) return row.id
  await db.run("INSERT INTO wallets (owner_type, owner_id) VALUES ('user', ?) ON CONFLICT DO NOTHING", userId)
  return (await db.get<{ id: number }>("SELECT id FROM wallets WHERE owner_type = 'user' AND owner_id = ?", userId))!.id
}

// Call inside tx() before reading a balance you are about to spend from: other transactions
// that spend from the same wallet wait until this one commits.
export async function lockWallet(walletId: number) {
  await db.get('SELECT id FROM wallets WHERE id = ? FOR UPDATE', walletId)
}

export async function balance(walletId: number): Promise<number> {
  return (await db.get<{ b: number }>('SELECT COALESCE(SUM(amount), 0) AS b FROM ledger_entries WHERE wallet_id = ?', walletId))!.b
}

async function insert(walletId: number, type: EntryType, amount: number, extra: { jobId?: number; related?: number; reason?: string; by?: number } = {}) {
  await db.run(`INSERT INTO ledger_entries (wallet_id, type, amount, job_id, related_wallet_id, reason, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, walletId, type, amount, extra.jobId ?? null, extra.related ?? null, extra.reason ?? null, extra.by ?? null, Date.now())
}

// Callers wrap these in tx().
export async function reserve(userId: number, jobId: number, amount: number) {
  const w = await userWalletId(userId)
  await lockWallet(w)
  const have = await balance(w)
  if (have < amount) throw new InsufficientCredits(`Needs ${amount} credits, you have ${have}`)
  await insert(w, 'reserve', -amount, { jobId })
}

export async function commit(userId: number, jobId: number, reserved: number, actual: number) {
  // Reserve already took the credits; commit records the final cost and returns any difference.
  await insert(await userWalletId(userId), 'commit', reserved - actual, { jobId, reason: `Final cost ${actual}` })
}

export async function refund(userId: number, jobId: number, amount: number, reason: string) {
  await insert(await userWalletId(userId), 'refund', amount, { jobId, reason })
}

export async function allocate(fromWallet: number, toWallet: number, amount: number, by: number, reason: string) {
  if (amount <= 0) throw new Error('Amount must be positive')
  await lockWallet(fromWallet)
  const have = await balance(fromWallet)
  if (have < amount) throw new InsufficientCredits(`The pool only has ${have} credits left`)
  await insert(fromWallet, 'allocation', -amount, { related: toWallet, reason, by })
  await insert(toWallet, 'allocation', amount, { related: fromWallet, reason, by })
}

export async function topup(walletId: number, amount: number, by: number, reason: string) {
  await insert(walletId, 'topup', amount, { reason, by })
}

export function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export type DailyAllowance = { limit: number | null; extra: number; spent: number; remaining: number | null }

// The balance is what a person owns; the daily limit is how fast they may spend it.
export async function dailyAllowance(userId: number): Promise<DailyAllowance> {
  const today = startOfToday()
  const { daily_limit: limit } = (await db.get<{ daily_limit: number | null }>('SELECT daily_limit FROM users WHERE id = ?', userId))!
  const { extra } = (await db.get<{ extra: number }>('SELECT COALESCE(SUM(amount), 0) AS extra FROM daily_extras WHERE user_id = ? AND day_start = ?', userId, today))!
  const spent = await spentSince(await userWalletId(userId), today)
  return { limit, extra, spent, remaining: limit == null ? null : Math.max(0, limit + extra - spent) }
}

export async function grantExtraToday(userId: number, amount: number, by: number) {
  await db.run('INSERT INTO daily_extras (user_id, day_start, amount, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, startOfToday(), amount, by, Date.now())
}

// Credits actually spent today: reserves minus whatever came back.
export async function spentSince(walletId: number | null, since: number): Promise<number> {
  const where = walletId == null ? "w.owner_type = 'user'" : 'w.id = ?'
  const args = walletId == null ? [since] : [walletId, since]
  const row = await db.get<{ s: number }>(`SELECT COALESCE(-SUM(e.amount), 0) AS s FROM ledger_entries e JOIN wallets w ON w.id = e.wallet_id
    WHERE ${where} AND e.type IN ('reserve','commit','refund') AND e.created_at >= ?`, ...args)
  return row!.s
}
