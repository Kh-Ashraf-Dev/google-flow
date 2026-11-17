import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { compare, hash, truncates } from 'bcryptjs'

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`
}

const BCRYPT_HASH = /^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/

export function isBcryptHash(value: string): boolean {
  return value.length === 60 && BCRYPT_HASH.test(value)
}

export async function hashBcryptPassword(password: string): Promise<string> {
  return hash(password, 12)
}

export function isValidNewPassword(password: string): boolean {
  return password.length >= 8 && !truncates(password)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (isBcryptHash(stored)) return !truncates(password) && await compare(password, stored)
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const a = Buffer.from(hash, 'hex')
  const b = scryptSync(password, salt, 32)
  return a.length === b.length && timingSafeEqual(a, b)
}
