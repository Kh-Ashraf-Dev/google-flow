import { randomBytes } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { db } from './db.ts'
import { verifyPassword } from './passwords.ts'

export type User = {
  id: number
  name: string
  email: string
  role: 'employee' | 'admin'
  department_id: number | null
  department: string | null
}

export type AppEnv = { Variables: { user: User } }

const COOKIE = 'studio_session'
const SESSION_MS = 7 * 24 * 60 * 60 * 1000

export function findUser(id: number): Promise<User | undefined> {
  return db.get<User>(`SELECT u.id, u.name, u.email, u.role, u.department_id, d.name AS department
    FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ? AND NOT u.disabled`, id)
}

export async function login(c: Context, email: string, password: string): Promise<User | null> {
  const row = await db.get<{ id: number; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = ? AND NOT disabled', email.trim().toLowerCase())
  if (!row || !(await verifyPassword(password, row.password_hash))) return null
  const token = randomBytes(32).toString('hex')
  const created = await db.run(`INSERT INTO sessions (token, user_id, expires_at)
    SELECT ?, id, ? FROM users WHERE id = ? AND password_hash = ? AND NOT disabled FOR SHARE`,
  token, Date.now() + SESSION_MS, row.id, row.password_hash)
  if (!created) return null
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SESSION_MS / 1000 })
  return (await findUser(row.id)) ?? null
}

export async function logout(c: Context) {
  const token = getCookie(c, COOKIE)
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', token)
  deleteCookie(c, COOKIE, { path: '/' })
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, COOKIE)
  const session = token ? await db.get<{ user_id: number; expires_at: number }>('SELECT user_id, expires_at FROM sessions WHERE token = ?', token) : undefined
  const user = session && session.expires_at > Date.now() ? await findUser(session.user_id) : undefined
  if (!user) return c.json({ error: 'Please sign in' }, 401)
  c.set('user', user)
  await next()
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') return c.json({ error: 'Admins only' }, 403)
  await next()
}
