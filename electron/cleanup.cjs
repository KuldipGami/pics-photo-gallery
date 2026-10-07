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

/** Rename, or copy + delete across drives. */
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    const st = await fsp.stat(from)
    await fsp.utimes(to, st.atime, st.mtime)
    await fsp.unlink(from)
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

/** Moves files into one folder (flat). Resolves to { files: [{from, to, size}], errors: [] }. */
async function moveTo(items, dest) {
  const files = []
  const errors = []
  try {
    await fsp.mkdir(dest, { recursive: true })
  } catch (err) {
    return { files, errors: items.map((it) => `${it.name}: ${err.message}`) }
  }
  for (const it of items) {
    try {
      const to = uniquePath(path.join(dest, it.name))
      await moveFile(it.path, to)
      files.push({ id: it.id, from: it.path, to, size: it.size })
    } catch (err) {
      errors.push(`${it.name}: ${err.message}`)
    }
  }
  return { files, errors }
}

async function recycle(items) {
  const files = []
  const errors = []
  for (const it of items) {
    try {
      await shell.trashItem(it.path)
      files.push({ id: it.id, from: it.path, size: it.size })
    } catch (err) {
      errors.push(`${it.name}: ${err.message}`)
    }
  }
  return { files, errors }
}

/** Puts moved/renamed files back where they were (never overwriting). Returns how many. */
async function restoreMoves(files) {
  let n = 0
  const emptied = new Set()
  for (const f of files) {
    if (f.restored || !f.to || exists(f.from) || !exists(f.to)) continue
    try {
      await fsp.mkdir(path.dirname(f.from), { recursive: true })
      await moveFile(f.to, f.from)
      f.restored = true
      emptied.add(path.dirname(f.to))
      n++
    } catch {}
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

module.exports = { uniquePath, moveFile, setFileDate, carryDates, restoreDates, moveTo, recycle, restoreMoves }
