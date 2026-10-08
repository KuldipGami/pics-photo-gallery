const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { shell } = require('electron')
const { knownDate } = require('./datetools.cjs')

// File actions for cleaning up (ported from DupeLens' FileOperations / OrganizeService):
// nothing is ever overwritten, everything is recorded in History, moves can be put back.

const DAY = 86_400_000

const exists = (p) => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/** "name.jpg" → "name (2).jpg", "name (3).jpg"… until the path is free. */
function uniquePath(target) {
  if (!exists(target)) return target
  const dir = path.dirname(target)
  const ext = path.extname(target)
  const stem = path.basename(target, ext)
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`)
    if (!exists(candidate)) return candidate
  }
}

/**
 * Copies to a path that must be free (never someone else's file). A copy cut short (disk full, the
 * drive went away) is removed again: whatever is at `to` after any other error than "exists" is ours.
 */
async function copyNew(from, to) {
  try {
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL)
  } catch (err) {
    if (err?.code !== 'EEXIST') await fsp.unlink(to).catch(() => {})
    throw err
  }
}

/**
 * Rename, or copy + delete across drives. A cross-drive move that can't finish (the copy came out
 * short, or the original couldn't be deleted) removes its copy again and throws, so the file is
 * only ever in one place.
 */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await copyNew(from, to)
    try {
      const st = await fsp.stat(from)
      if ((await fsp.stat(to)).size !== st.size) throw new Error(`the copy in ${path.dirname(to)} came out incomplete`)
      await fsp.utimes(to, st.atime, st.mtime)
      await fsp.unlink(from)
    } catch (failed) {
      await fsp.unlink(to).catch(() => {})
      throw failed
    }
  }
}

// ── XMP sidecars ("IMG_1.xmp" from Lightroom, "IMG_1.HEIC.xmp" from darktable / digiKam) ──

/**
 * Finds the sidecars of the files one job moves (one folder listing per folder). "IMG_1.HEIC.xmp"
 * always belongs to IMG_1.HEIC; "IMG_1.xmp" only when no other file there is called IMG_1 (RAW +
 * JPEG pairs and Live Photos share it, so it stays with the files left behind).
 * find(file) → { from, full } | null.
 */
function sidecarFinder() {
  const dirs = new Map() // lower-case folder → { xmp: Map(lower name → name), stems: Map(lower stem → count) } | null
  const listing = async (dir) => {
    const key = dir.toLowerCase()
    if (dirs.has(key)) return dirs.get(key)
    let names = []
    try {
      names = await fsp.readdir(dir)
    } catch {}
    let index = null
    if (names.some((n) => n.toLowerCase().endsWith('.xmp'))) {
      index = { xmp: new Map(), stems: new Map() }
      for (const n of names) {
        const lower = n.toLowerCase()
        if (lower.endsWith('.xmp')) index.xmp.set(lower, n)
        else {
          const stem = path.basename(lower, path.extname(lower))
          index.stems.set(stem, (index.stems.get(stem) ?? 0) + 1)
        }
      }
    }
    dirs.set(key, index)
    return index
  }
  return {
    /** `together`: how many files with this name move as one (a Live Photo's still and clip: 2). */
    async find(file, together = 1) {
      const dir = path.dirname(file)
      const index = await listing(dir)
      if (!index) return null
      const name = path.basename(file).toLowerCase()
      const full = index.xmp.get(`${name}.xmp`)
      if (full) return { from: path.join(dir, full), full: true }
      const stem = path.basename(name, path.extname(name))
      const own = index.xmp.get(`${stem}.xmp`)
      if (!own || (index.stems.get(stem) ?? 0) > together) return null
      return { from: path.join(dir, own), full: false }
    },
    /** The sidecar has left its folder. */
    gone(sidecarPath) {
      dirs.get(path.dirname(sidecarPath).toLowerCase())?.xmp.delete(path.basename(sidecarPath).toLowerCase())
    },
  }
}

/** Where a sidecar goes when its file goes to `to`: same naming style, the sidecar's own extension. */
function sidecarTarget(sidecar, to) {
  const ext = path.extname(sidecar.from) // ".xmp" / ".XMP"
  if (sidecar.full) return `${to}${ext}`
  return path.join(path.dirname(to), path.basename(to, path.extname(to)) + ext)
}

/** `wanted` with " (n)" added to its name (n = 1: as it is). */
const numbered = (wanted, n) => {
  if (n === 1) return wanted
  const ext = path.extname(wanted)
  return path.join(path.dirname(wanted), `${path.basename(wanted, ext)} (${n})${ext}`)
}

/**
 * uniquePath for files that go together (a file and its sidecar; a Live Photo's still and clip with
 * theirs): the first " (n)" where none of them is taken, so they keep matching names.
 * `list`: [{ wanted, sidecar }] → [{ to, sidecarTo }].
 */
function uniqueTargets(list) {
  for (let n = 1; ; n++) {
    const out = list.map(({ wanted, sidecar }) => {
      const to = numbered(wanted, n)
      return { to, sidecarTo: sidecar ? sidecarTarget(sidecar, to) : null }
    })
    if (out.every((t) => !exists(t.to) && !(t.sidecarTo && exists(t.sidecarTo)))) return out
  }
}

/**
 * Moves (or copies) a file to `wanted` — " (2)" etc. when taken, never overwriting — with its XMP
 * sidecar. Resolves { to, sidecar: { from, to } | null, note: string | null } (`note` when the
 * file moved but its sidecar couldn't); throws when the file itself couldn't be moved.
 */
async function transferFile(from, wanted, { copy = false, sidecars = sidecarFinder() } = {}) {
  const [res] = await transferFiles([{ from, wanted }], { copy, sidecars })
  if (res.error) throw res.error
  return res
}

/**
 * transferFile for files that belong together (a Live Photo's still, then its clip): they get the
 * same " (n)" so their names keep matching. The first is moved first; if it fails, none is moved
 * and that error is thrown. Resolves one result per file: { to, sidecar, note } or { error } (a
 * later file that couldn't follow).
 */
async function transferFiles(list, { copy = false, sidecars = sidecarFinder() } = {}) {
  const found = []
  for (const f of list) {
    const sc = await sidecars.find(f.from, list.length)
    found.push(sc && found.some((x) => x?.from === sc.from) ? null : sc) // a shared "IMG_1.xmp" goes once, with the first
  }
  const targets = uniqueTargets(list.map((f, i) => ({ wanted: f.wanted, sidecar: found[i] })))
  const results = []
  for (let i = 0; i < list.length; i++) {
    try {
      results.push(await transferOne(list[i].from, targets[i].to, found[i], targets[i].sidecarTo, { copy, sidecars }))
    } catch (err) {
      if (i === 0) throw err
      results.push({ error: err })
    }
  }
  return results
}

/** One file (and its sidecar) to a target already known to be free. */
async function transferOne(from, to, sidecar, sidecarTo, { copy, sidecars }) {
  if (copy) {
    await copyNew(from, to)
    try {
      const st = await fsp.stat(from)
      await fsp.utimes(to, st.atime, st.mtime)
    } catch (err) {
      await fsp.unlink(to).catch(() => {}) // no copy left behind that History doesn't know about
      throw err
    }
  } else await moveFile(from, to)
  if (!sidecar) return { to, sidecar: null, note: null }
  try {
    if (exists(sidecarTo)) throw new Error(`${path.basename(sidecarTo)} already exists there`)
    if (copy) await copyNew(sidecar.from, sidecarTo)
    else {
      await moveFile(sidecar.from, sidecarTo)
      sidecars.gone(sidecar.from)
    }
    return { to, sidecar: { from: sidecar.from, to: sidecarTo }, note: null }
  } catch (err) {
    return { to, sidecar: null, note: `${path.basename(from)}: done, but its XMP sidecar ${path.basename(sidecar.from)} stayed where it was (${err.message})` }
  }
}

async function setFileDate(file, ms) {
  const st = await fsp.stat(file)
  await fsp.utimes(file, st.atime, new Date(ms))
  return st.mtimeMs
}

/**
 * Before copies are removed: a kept copy with no capture date of its own (e.g. a WhatsApp copy)
 * whose file date is more than a day after the group's earliest known date gets that date, so it
 * still sorts where the photo was taken. Returns the changes (for undo).
 */
async function carryDates(groups, removing, byId) {
  const changes = []
  for (const g of groups) {
    const members = g.ids.map((id) => byId.get(id)).filter(Boolean)
    const kept = members.filter((it) => !removing.has(it.id))
    if (!kept.length || kept.length === members.length) continue
    const dates = members.map(knownDate).filter((d) => d !== null)
    if (!dates.length) continue
    const earliest = Math.min(...dates)
    for (const it of kept) {
      if (knownDate(it) !== null || it.mtime <= earliest + DAY) continue
      try {
        const oldMtime = await setFileDate(it.path, earliest)
        changes.push({ path: it.path, oldMtime })
      } catch {}
    }
  }
  return changes
}

async function restoreDates(changes) {
  let n = 0
  for (const c of changes ?? []) {
    if (c.restored || !Number.isFinite(c.oldMtime)) continue
    try {
      await setFileDate(c.path, c.oldMtime)
      c.restored = true
      n++
    } catch {}
  }
  return n
}

/**
 * Moves files into one folder (flat), each with its XMP sidecar. `signal` (AbortSignal) stops
 * before the next file; what was moved by then is returned as usual.
 * Resolves to { files: [{ id, from, to, size, sidecar?: { from, to } }], errors: [], notes: [] }
 * (`notes`: files that moved but whose sidecar stayed behind — not failures).
 */
async function moveTo(items, dest, { signal } = {}) {
  const files = []
  const errors = []
  const notes = []
  try {
    await fsp.mkdir(dest, { recursive: true })
  } catch (err) {
    return { files, errors: items.map((it) => `${it.name}: ${err.message}`), notes }
  }
  const sidecars = sidecarFinder()
  for (const it of items) {
    if (signal?.aborted) break
    try {
      const res = await transferFile(it.path, path.join(dest, it.name), { sidecars })
      const rec = { id: it.id, from: it.path, to: res.to, size: it.size }
      if (res.sidecar) rec.sidecar = res.sidecar
      if (res.note) notes.push(res.note)
      files.push(rec)
    } catch (err) {
      errors.push(`${it.name}: ${err.message}`)
    }
  }
  return { files, errors, notes }
}

/** Sends files to the Recycle Bin. `signal` stops before the next file (what was done is returned). */
async function recycle(items, { signal } = {}) {
  const files = []
  const errors = []
  for (const it of items) {
    if (signal?.aborted) break
    try {
      await shell.trashItem(it.path)
      files.push({ id: it.id, from: it.path, size: it.size })
    } catch (err) {
      errors.push(`${it.name}: ${err.message}`)
    }
  }
  return { files, errors }
}

/** Moves a file's sidecar back with it (never overwriting one that's there now). */
async function restoreSidecar(f) {
  const s = f.sidecar
  if (!s?.from || !s.to || s.restored || !exists(s.to) || exists(s.from)) return
  try {
    await moveFile(s.to, s.from)
    s.restored = true
  } catch {}
}

/** Puts moved/renamed files back where they were, with their sidecars (never overwriting). Returns how many. */
async function restoreMoves(files) {
  let n = 0
  const emptied = new Set()
  for (const f of files) {
    if (f.restored) {
      if (f.sidecar) await restoreSidecar(f) // its sidecar couldn't come back last time
      continue
    }
    if (!f.to || exists(f.from) || !exists(f.to)) continue
    try {
      await fsp.mkdir(path.dirname(f.from), { recursive: true })
      await moveFile(f.to, f.from)
      f.restored = true
      emptied.add(path.dirname(f.to))
      n++
    } catch {
      continue
    }
    if (f.sidecar) await restoreSidecar(f)
  }
  // tidy up folders that are now empty (the destination and one parent)
  for (const dir of emptied) {
    for (const d of [dir, path.dirname(dir)]) {
      try {
        if (!(await fsp.readdir(d)).length) await fsp.rmdir(d)
      } catch {}
    }
  }
  return n
}

module.exports = { uniquePath, moveFile, transferFile, transferFiles, sidecarFinder, setFileDate, carryDates, restoreDates, moveTo, recycle, restoreMoves }
