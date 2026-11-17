import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const envFile = resolve(import.meta.dirname, '..', '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

const vertexKey = process.env.VERTEX_KEY_JSON
  ?? (process.env.VERTEX_KEY_FILE && existsSync(resolve(import.meta.dirname, '..', process.env.VERTEX_KEY_FILE))
    ? readFileSync(resolve(import.meta.dirname, '..', process.env.VERTEX_KEY_FILE), 'utf8') : '')

export const config = {
  // Not PORT: dev tools set that for Vite, and the Vite proxy expects the API on 8787.
  port: Number(process.env.API_PORT ?? 8787),
  // Neon Postgres connection string (the pooled one).
  databaseUrl: process.env.DATABASE_URL ?? '',
  dataDir: process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(import.meta.dirname, '..', 'data'),
  // Without Vertex credentials, generations use the local mock provider.
  mock: !vertexKey.trim() || process.env.MOCK_PROVIDER === '1',
  models: {
    helper: process.env.HELPER_MODEL ?? 'gemini-3.8-flash',
    helperFallback: process.env.HELPER_FALLBACK_MODEL ?? 'gemini-3.5-flash',
    // Image upscale redraws with Nano Banana 2 (Imagen is no longer on Vertex for this project).
    imageUpscale: process.env.IMAGE_UPSCALE_MODEL ?? 'gemini-3.1-flash-image',
    generation: {
      'omni-flash-1.2': 'gemini-omni-1.2-flash',
      'omni-flash': 'gemini-omni-1.1-flash-preview',
      'veo-3.1': 'veo-3.1-generate-001',
      'veo-3.1-fast': 'veo-3.1-fast-generate-001',
      'veo-3.1-lite': 'veo-3.1-lite-generate-001',
      'nano-banana-2-lite': 'gemini-3.1-flash-lite-image',
      'nano-banana-2.1': 'gemini-nano-banana-2.1',
      'nano-banana': 'gemini-2.5-flash-image',
      'gemini-image': process.env.IMAGE_MODEL ?? 'gemini-3.1-flash-image',
      'nano-banana-pro': 'gemini-3-pro-image',
    } as Record<string, string>,
  },
  vertex: {
    keyJson: vertexKey,
    location: process.env.VERTEX_LOCATION ?? 'us-central1',
  },
  // Hard stop on what Google can charge in one day, in USD.
  dailySpendCapUsd: Number(process.env.DAILY_SPEND_CAP_USD ?? 5),
  jobTimeoutMs: 10 * 60 * 1000,
}
