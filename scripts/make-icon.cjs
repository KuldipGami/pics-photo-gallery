// Renders resources/icon.svg to resources/icon.png (512px) using Electron's Chromium.
// Run with: npm run icon
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const root = path.join(__dirname, '..')
const svg = fs.readFileSync(path.join(root, 'resources', 'icon.svg'), 'utf8')
const SIZE = 512

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const dataUrl = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}'
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = ${SIZE}
    canvas.getContext('2d').drawImage(img, 0, 0, ${SIZE}, ${SIZE})
    return canvas.toDataURL('image/png')
  })()`)
  const out = path.join(root, 'resources', 'icon.png')
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('Wrote', out)
  app.quit()
})
