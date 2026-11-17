// One-off, 2026-11-11: a credit went from $0.08 to $0.04 (to match Google Flow's numbers), so
// every balance, daily limit, today's extras and pending request doubles. Nobody gains or
// loses money. The ledger stays append-only: each wallet gets an 'adjustment' entry equal to
// its balance. Runs once (checks the audit log) and refuses while a job holds reserved credits.
//
//   node --disable-warning=ExperimentalWarning scripts/rescale-credits.ts          (uses DATABASE_URL)
import { audit, db, tx } from '../server/db.ts'
import * as ledger from '../server/ledger.ts'

const done = await db.get("SELECT id FROM audit_logs WHERE action = 'credits.rescaled'")
if (done) {
  console.log('Already rescaled, nothing to do.')
  process.exit(0)
}
const running = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('reserved','running')")
if (running!.n > 0) throw new Error(`${running!.n} job(s) are still running; their reserved credits are in the old units. Try again when they finish.`)

const today = ledger.startOfToday()
const summary = await tx(async () => {
  const wallets = await db.all<{ id: number; owner_type: string; owner_id: number | null }>('SELECT * FROM wallets ORDER BY id')
  const balances: Record<string, [number, number]> = {}
  for (const w of wallets) {
    await ledger.lockWallet(w.id)
    const b = await ledger.balance(w.id)
    if (b !== 0) {
      await db.run(`INSERT INTO ledger_entries (wallet_id, type, amount, reason, created_at) VALUES (?, 'adjustment', ?, ?, ?)`,
        w.id, b, 'Credits now $0.04 each (were $0.08): balance doubled, same value', Date.now())
    }
    balances[w.owner_type === 'org' ? 'pool' : `user ${w.owner_id}`] = [b, b * 2]
  }
  const limits = await db.run('UPDATE users SET daily_limit = daily_limit * 2 WHERE daily_limit IS NOT NULL')
  const extras = await db.run('UPDATE daily_extras SET amount = amount * 2 WHERE day_start = ?', today)
  // What was spent today is in old credits. Remaining today should double too:
  // 2·(limit + extra − spent) = 2·limit + 2·extra − 2·spent, so count today's spending twice.
  const users = await db.all<{ id: number; wallet: number }>(`SELECT u.id, w.id AS wallet FROM users u JOIN wallets w ON w.owner_type = 'user' AND w.owner_id = u.id`)
  for (const u of users) {
    const spent = await ledger.spentSince(u.wallet, today)
    if (spent > 0) {
      await db.run('INSERT INTO daily_extras (user_id, day_start, amount, created_by, created_at) VALUES (?, ?, ?, NULL, ?)', u.id, today, -spent, Date.now())
    }
  }
  const requests = await db.run("UPDATE topup_requests SET amount = amount * 2 WHERE status = 'pending'")
  await audit(null, 'credits.rescaled', { from: 0.08, to: 0.04, balances })
  return { balances, limits, extras, requests }
})
console.log(JSON.stringify(summary, null, 2))
process.exit(0)
