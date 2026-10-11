const fsp = require('node:fs/promises')
const path = require('node:path')

/**
 * Library folders on drives that come and go (an external SSD, a memory card). Windows may give a
 * drive another letter the next time it's plugged in (E: one day, F: the next), so each library
 * folder's drive is remembered by its volume serial number (what `vol E:` shows, and Node's
 * stat().dev on Windows) with the folder's place on it. A folder missing at its old letter is then
 * found again at the new one, and keeps what Pics knows about its photos.
 */

const isLocal = (p) => /^[a-z]:[\\/]/i.test(String(p ?? ''))
const LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ'

/** { serial, rel } for a library folder that's there now; null for a network path or a missing folder. */
async function identify(folder) {
  if (!isLocal(folder)) return null
  const full = path.resolve(folder)
  const root = path.parse(full).root
  const [st, rootSt] = await Promise.all([fsp.stat(full).catch(() => null), fsp.stat(root).catch(() => null)])
  if (!st?.isDirectory() || !rootSt?.dev) return null
  return { serial: rootSt.dev, rel: path.relative(root, full) }
}

/**
 * Where missing library folder `folder` is now: the same place on the same drive (`known`, what
 * identify() said while it was there) under another letter, holding at least half of `sample`
 * (some of its library items: [{ path, size, mtime }]) at the same size. Without `known` (folders
 * from before Pics remembered drives), it has to hold most of the sample unchanged (size and time;
 * `sameTime` from library.cjs), at least 3 of them. Resolves to the new path, or null.
 */
async function findMoved(folder, known, sample, sameTime) {
  if (!isLocal(folder)) return null
  const full = path.resolve(folder)
  const oldLetter = full[0].toUpperCase()
  const rel = typeof known?.rel === 'string' ? known.rel : path.relative(path.parse(full).root, full)
  for (const letter of LETTERS) {
    if (letter === oldLetter) continue
    const root = `${letter}:\\`
    const st = await fsp.stat(root).catch(() => null)
    if (!st) continue
    if (known && st.dev !== known.serial) continue
    const candidate = rel ? path.join(root, rel) : root
    const dir = await fsp.stat(candidate).catch(() => null)
    if (!dir?.isDirectory()) continue
    let same = 0
    for (const it of sample) {
      const f = await fsp.stat(path.join(candidate, path.relative(full, it.path))).catch(() => null)
      if (f && f.size === it.size && (known || sameTime(it.mtime, Math.round(f.mtimeMs)))) same++
    }
    if (known ? same * 2 >= sample.length : sample.length >= 3 && same * 5 >= sample.length * 4) return candidate
  }
  return null
}

module.exports = { identify, findMoved, isLocal }
