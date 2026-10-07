const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { Readable } = require('node:stream')
const { protocol } = require('electron')
const { MIME } = require('./library.cjs')

const SCHEME = 'gallery'
const CORS = { 'Access-Control-Allow-Origin': '*' }

/** Must run before the app is ready. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}

const notFound = () => new Response('Not found', { status: 404, headers: CORS })

/** Streams a file, honouring HTTP Range requests so videos can seek. */
async function serveFile(item, request) {
  let st
  try {
    st = await fsp.stat(item.path)
  } catch {
    return notFound()
  }
  const headers = {
    ...CORS,
    'Content-Type': MIME[item.ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  }
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : NaN
    let end = range[2] ? Number(range[2]) : NaN
    if (Number.isNaN(start)) {
      start = Math.max(0, st.size - end)
      end = st.size - 1
    } else if (Number.isNaN(end) || end >= st.size) {
      end = st.size - 1
    }
    if (start >= st.size || start > end) {
      return new Response(null, { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${st.size}` } })
    }
    const stream = fs.createReadStream(item.path, { start, end })
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` },
    })
  }
  return new Response(Readable.toWeb(fs.createReadStream(item.path)), {
    headers: { ...headers, 'Content-Length': String(st.size) },
  })
}

/**
 * gallery://media/<id>     original file (range-aware)
 * gallery://thumb/<id>     480px cached thumbnail
 * gallery://preview/<id>   2560px rendition for formats Chromium can't decode (HEIC, TIFF, RAW)
 * Only ids present in the library index are served, so the renderer can't read arbitrary files.
 */
function handleProtocol({ library, thumbs }) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const item = library.get(url.pathname.slice(1))
    if (!item) return notFound()
    if (url.hostname === 'media') return serveFile(item, request)
    if (url.hostname === 'thumb' || url.hostname === 'preview') {
      const data = await thumbs.get(item, url.hostname).catch(() => null)
      if (!data) return notFound()
      const type = data.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : 'image/jpeg'
      return new Response(data, {
        headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'max-age=31536000, immutable' },
      })
    }
    return notFound()
  })
}

module.exports = { registerScheme, handleProtocol }
