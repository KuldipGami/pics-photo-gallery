import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Strict CSP for the packaged app (dev needs inline scripts for React Refresh).
const csp: Plugin = {
  name: 'lumen-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' gallery: data: blob:; media-src 'self' gallery: blob:; connect-src 'self' gallery:; font-src 'self' data:" />`,
    ),
}

export default defineConfig({
  base: './',
  plugins: [react(), csp],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { port: 5173 },
})
