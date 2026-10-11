const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/**
 * Putting files Pics moved to the Recycle Bin back where they were (Ctrl+Z / History → Restore).
 *
 * Windows keeps a recycled file as <drive>\$Recycle.Bin\<user SID>\$R<id><ext>, next to a small
 * $I<id><ext> record holding its original path and when it was deleted. Restoring is what Explorer's
 * "Restore" does: rename the $R file back to the original path and remove its $I record. Only the
 * current user's folder can be read, which is the one we want.
 *
 * $I format: version (int64: 1 = Windows Vista–8.1, 2 = Windows 10+), file size (int64), deletion
 * time (FILETIME), then the path: v1 a fixed 260-character UTF-16 field, v2 a character count
 * (int32) and that many UTF-16 characters (with the terminating zero).
 */

const FILETIME_EPOCH_MS = 11644473600000n

function parseInfo(buf) {
  if (buf.length < 24) return null
  const version = Number(buf.readBigInt64LE(0))
  const deletedAt = Number(buf.readBigInt64LE(16) / 10000n - FILETIME_EPOCH_MS)
  let raw
  if (version === 2 && buf.length >= 28) {
    const chars = buf.readInt32LE(24)
    raw = buf.subarray(28, 28 + Math.max(0, chars) * 2)
  } else if (version === 1) raw = buf.subarray(24, 24 + 520)
  else return null
  const original = raw.toString('utf16le').replace(/\0[\s\S]*$/, '')
  return original ? { original, deletedAt } : null
}

const key = (p) => path.resolve(p).toLowerCase()

/** The readable (= this user's) Recycle Bin folders on the drive of `file`. */
async function binFoldersFor(file) {
  const root = path.join(path.parse(path.resolve(file)).root, '$Recycle.Bin')
  const out = []
  for (const name of await fsp.readdir(root).catch(() => [])) {
    const dir = path.join(root, name)
    try {
      await fsp.access(dir, fs.constants.R_OK)
      await fsp.readdir(dir)
      out.push(dir)
    } catch {}
  }
  return out
}

/** Every $I record in `dir`: [{ info, data, original, deletedAt }]. */
async function recordsIn(dir) {
  const out = []
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    if (!/^\$I/i.test(name)) continue
    const info = path.join(dir, name)
    const buf = await fsp.readFile(info).catch(() => null)
    const parsed = buf && parseInfo(buf)
    if (!parsed) continue
    const data = path.join(dir, '$R' + name.slice(2))
    out.push({ info, data, ...parsed })
  }
  return out
}

/**
 * Restores `files` ([{ from, restored? }] as History keeps them) that were recycled at or after
 * `since` (ms; a minute's slack). Marks each one put back `restored`; one whose original place is
 * taken again, or that's no longer in the Recycle Bin, is left. Resolves to how many came back.
 */
async function restoreFromRecycleBin(files, since = 0) {
  const pending = files.filter((f) => !f.restored && typeof f.from === 'string')
  if (!pending.length) return 0
  const wanted = new Map(pending.map((f) => [key(f.from), f]))
  // one look per drive's bin
  const byBin = new Map()
  for (const f of pending) for (const dir of await binFoldersFor(f.from)) byBin.set(dir, true)
  const candidates = new Map() // key(original) -> newest record deleted since `since`
  for (const dir of byBin.keys()) {
    for (const r of await recordsIn(dir)) {
      const k = key(r.original)
      if (!wanted.has(k) || r.deletedAt < since - 60_000) continue
      const best = candidates.get(k)
      if (!best || r.deletedAt > best.deletedAt) candidates.set(k, r)
    }
  }
  let n = 0
  for (const [k, f] of wanted) {
    const r = candidates.get(k)
    if (!r || fs.existsSync(f.from) || !fs.existsSync(r.data)) continue
    try {
      await fsp.mkdir(path.dirname(f.from), { recursive: true })
      await fsp.rename(r.data, f.from)
      await fsp.unlink(r.info).catch(() => {})
      f.restored = true
      n++
    } catch {}
  }
  return n
}

module.exports = { restoreFromRecycleBin, parseInfo }
