// Runs the API and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process'

const procs = [
  spawn(process.execPath, ['--watch', '--disable-warning=ExperimentalWarning', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
]
const stop = () => procs.forEach((p) => p.kill())
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code) } }))
