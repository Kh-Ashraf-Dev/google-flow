// Copies every row from the old SQLite file into Postgres, keeping ids, then moves each id
// sequence past the highest id. Replaces whatever the target has, in one transaction.
//
//   DATABASE_URL=postgres://… node --disable-warning=ExperimentalWarning scripts/sqlite-to-neon.ts path/to/studio.db
import { DatabaseSync } from 'node:sqlite'
import { db, initDb, tx } from '../server/db.ts'

const file = process.argv[2]
if (!file) throw new Error('Pass the SQLite file to copy from')
const src = new DatabaseSync(file, { readOnly: true })

// Parents before children, for the foreign keys.
const TABLES = [
  'departments', 'users', 'sessions', 'wallets', 'ledger_entries', 'pricing_rules', 'policy_rules',
  'blocked_keywords', 'prompt_checks', 'jobs', 'assets', 'topup_requests', 'audit_logs', 'daily_extras',
  'scenes', 'scene_clips',
]

await initDb() // creates the tables if they aren't there yet
const counts: Record<string, number> = {}
await tx(async () => {
  await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
  for (const table of TABLES) {
    const exists = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    const rows = exists ? (src.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) : []
    for (const row of rows) {
      const cols = Object.keys(row)
      await db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c]))
    }
    counts[table] = rows.length
    if (table !== 'sessions' && table !== 'pricing_rules') {
      await db.exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`)
    }
  }
})
console.table(counts)
process.exit(0)
