const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { isJpeg, writeExif, readOrientation, rotateOrientation, replaceWithTemp, MSG } = require('./jpeg-exif.cjs')

// In-place photo edits (date taken, rotation), ported from DupeLens' EditService. Every edit first
// copies the original into the backups folder, so History can put the exact original back.
// History record per file: { from: photo, to: its backup, size, oldMtime, restored? }.

const exists = (p) => {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

const toMs = (d) => (d instanceof Date ? d.getTime() : typeof d === 'string' ? new Date(d).getTime() : Number(d))

/**
 * Backs up the file, runs `edit(path)` (resolving null or an error string), then sets the file's
 * modified date: `mtime` (Date | ms) when given, else the original one when `keepTimes` (default).
 * Resolves { file: historyFile } or { error }.
 */
async function editWithBackup(item, backupsDir, edit, { keepTimes = true, mtime } = {}) {
  let backup = null
  try {
    const st = await fsp.stat(item.path)
    await fsp.mkdir(backupsDir, { recursive: true })
    const ext = item.ext || path.extname(item.path).slice(1).toLowerCase()
    backup = path.join(backupsDir, `${crypto.randomBytes(16).toString('hex')}${ext ? `.${ext}` : ''}`)
    await fsp.copyFile(item.path, backup, fs.constants.COPYFILE_EXCL)
    const file = { from: item.path, to: backup, size: st.size, oldMtime: st.mtimeMs }

    const error = await edit(item.path)
    if (error) {
      await fsp.unlink(backup).catch(() => {})
      return { error: String(error) }
    }

    // The photo has changed: from here on the backup must be kept so History can undo it.
    backup = null
    try {
      // Keep the file's date (edits shouldn't make old photos look new), or set the new date taken.
      const newMs = mtime != null ? toMs(mtime) : keepTimes ? st.mtimeMs : NaN
      if (Number.isFinite(newMs)) await fsp.utimes(item.path, st.atimeMs / 1000, newMs / 1000)
    } catch {
      // File dates are cosmetic; the edit itself succeeded.
    }
    return { file }
  } catch (err) {
    // The edit didn't happen (the original is untouched), so its backup isn't needed.
    if (backup) await fsp.unlink(backup).catch(() => {})
    return { error: err.message }
  }
}

/** Writes the date taken into a JPEG (lossless) and gives the file that date as its modified date. */
async function setDateTaken(item, date, backupsDir) {
  const ms = date == null ? NaN : toMs(date)
  if (!Number.isFinite(ms)) return { error: MSG.badDate }
  if (!isJpeg(item.ext || item.path)) return { error: MSG.notJpeg }
  return editWithBackup(item, backupsDir, (p) => writeExif(p, { taken: ms }), { mtime: ms })
}

/**
 * Turns a JPEG by quarter turns clockwise (negative = anticlockwise) by changing only its EXIF
 * orientation; the file keeps its modified date. Resolves { file, orientation } or { error }.
 */
async function rotate(item, quarterTurnsCW, backupsDir) {
  if (!isJpeg(item.ext || item.path)) return { error: MSG.notJpeg }
  const turns = (((Math.trunc(quarterTurnsCW) || 0) % 4) + 4) % 4
  if (!turns) return { error: 'Nothing to rotate.' }
  let orientation
  try {
    orientation = rotateOrientation(await readOrientation(item.path), turns)
  } catch (err) {
    return { error: err.message }
  }
  const res = await editWithBackup(item, backupsDir, (p) => writeExif(p, { orientation }), { keepTimes: true })
  return res.error ? res : { ...res, orientation }
}

/**
 * Puts backed-up originals back over edited files (with their old modified date) and deletes the
 * backups. Marks each history file `restored`; returns the files that were restored.
 */
async function restoreBackups(files) {
  const restored = []
  for (const f of files ?? []) {
    if (!f || f.restored || !f.to || !f.from || !exists(f.to)) continue
    const temp = `${f.from}.lumen.tmp`
    try {
      await fsp.copyFile(f.to, temp)
      if (exists(f.from)) await replaceWithTemp(temp, f.from)
      else await fsp.rename(temp, f.from) // the edited photo is gone (moved or deleted): put the original back
    } catch {
      await fsp.unlink(temp).catch(() => {})
      continue // leave it for another attempt
    }
    if (Number.isFinite(f.oldMtime)) await fsp.utimes(f.from, Date.now() / 1000, f.oldMtime / 1000).catch(() => {})
    await fsp.unlink(f.to).catch(() => {})
    f.restored = true
    restored.push(f)
  }
  return restored
}

/**
 * Deletes the backups kept by 'edited' history entries (e.g. when History is cleared). With
 * `backupsDir`, only files inside that folder are deleted. Returns how many were removed.
 */
async function deleteBackups(entries, backupsDir) {
  const root = backupsDir ? path.resolve(backupsDir).toLowerCase() + path.sep : null
  let n = 0
  for (const e of entries ?? []) {
    if (e?.kind !== 'edited') continue
    for (const f of e.files ?? []) {
      if (!f?.to || f.to === f.from) continue
      if (root && !path.resolve(f.to).toLowerCase().startsWith(root)) continue
      try {
        await fsp.unlink(f.to)
        n++
      } catch {}
    }
  }
  return n
}

module.exports = { editWithBackup, setDateTaken, rotate, restoreBackups, deleteBackups }
