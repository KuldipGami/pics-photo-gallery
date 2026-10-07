// Starts the Vite dev server, then launches Electron pointed at it.
// Restarts Electron automatically when files in electron/ change.
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const electronPath = createRequire(import.meta.url)('electron')
const server = await createServer()
await server.listen()
const url = server.resolvedUrls.local[0]
server.printUrls()

let child = null
let restarting = false

function launch() {
  child = spawn(electronPath, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  })
  child.on('close', (code) => {
    if (restarting) return
    server.close()
    process.exit(code ?? 0)
  })
}

let timer
watch('electron', () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    console.log('[dev] electron/ changed, restarting app...')
    restarting = true
    child.once('close', () => {
      restarting = false
      launch()
    })
    child.kill()
  }, 300)
})

launch()
