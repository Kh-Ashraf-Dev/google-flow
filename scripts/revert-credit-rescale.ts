// One-off, 2026-11-11: undoes scripts/rescale-credits.ts. A credit is back to $0.08, so every
// balance, daily limit, today's extras and pending request halves. The ledger stays
// append-only: each wallet gets an 'adjustment' entry for minus half its balance. Runs once,
// only after the rescale, and refuses while a job holds reserved credits.
//
//   node --disable-warning=ExperimentalWarning scripts/revert-credit-rescale.ts      (uses DATABASE_URL)
import { audit, db, tx } from '../server/db.ts'
import * as ledger from '../server/ledger.ts'

const rescale = await db.get<{ created_at: number }>("SELECT created_at FROM audit_logs WHERE action = 'credits.rescaled' ORDER BY id DESC LIMIT 1")
if (!rescale) {
  console.log('Credits were never rescaled, nothing to undo.')
  process.exit(0)
}
if (await db.get("SELECT id FROM audit_logs WHERE action = 'credits.rescale_reverted' AND created_at >= ?", rescale.created_at)) {
  console.log('Already reverted, nothing to do.')
  process.exit(0)
}
const running = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('reserved','running')")
if (running!.n > 0) throw new Error(`${running!.n} job(s) are still running; try again when they finish.`)

const today = ledger.startOfToday()
const summary = await tx(async () => {
  const wallets = await db.all<{ id: number; owner_type: string; owner_id: number | null }>('SELECT * FROM wallets ORDER BY id')
  const balances: Record<string, [number, number]> = {}
  for (const w of wallets) {
    await ledger.lockWallet(w.id)
    const b = await ledger.balance(w.id)
    const half = Math.round(b / 2)
    if (b !== half) {
      await db.run(`INSERT INTO ledger_entries (wallet_id, type, amount, reason, created_at) VALUES (?, 'adjustment', ?, ?, ?)`,
        w.id, half - b, 'Credits back to $0.08 each (were $0.04): balance halved, same value', Date.now())
    }
    balances[w.owner_type === 'org' ? 'pool' : `user ${w.owner_id}`] = [b, half]
  }
  const limits = await db.run('UPDATE users SET daily_limit = ROUND(daily_limit / 2.0) WHERE daily_limit IS NOT NULL')

  // Today's allowance. The rescale doubled today's extras and added a "−spent" extra per
  // person; drop those, halve the rest, and give back half of anything spent since the
  // rescale (it was counted in $0.04 credits).
  const fixes = await db.run('DELETE FROM daily_extras WHERE day_start = ? AND created_by IS NULL AND amount < 0 AND created_at >= ?', today, rescale.created_at)
  const extras = await db.run('UPDATE daily_extras SET amount = ROUND(amount / 2.0) WHERE day_start = ?', today)
  const users = await db.all<{ id: number; wallet: number }>(`SELECT u.id, w.id AS wallet FROM users u JOIN wallets w ON w.owner_type = 'user' AND w.owner_id = u.id`)
  for (const u of users) {
    const since = await ledger.spentSince(u.wallet, Math.max(today, rescale.created_at))
    if (since > 0) {
      await db.run('INSERT INTO daily_extras (user_id, day_start, amount, created_by, created_at) VALUES (?, ?, ?, NULL, ?)', u.id, today, Math.round(since / 2), Date.now())
    }
  }
  const requests = await db.run("UPDATE topup_requests SET amount = ROUND(amount / 2.0) WHERE status = 'pending'")
  await audit(null, 'credits.rescale_reverted', { from: 0.04, to: 0.08, balances })
  return { balances, limits, removedFixes: fixes, extras, requests }
})
console.log(JSON.stringify(summary, null, 2))
process.exit(0)
