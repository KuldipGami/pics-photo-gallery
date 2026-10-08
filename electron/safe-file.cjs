const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/**
 * Saving Lumen's own data (faces.json, library.json, tags.json…) so a crash, a full disk or a
 * scanner briefly holding the file never leaves it half written:
 * - every write goes to a temp file of its own (two saves never share one), is flushed to disk,
 *   then renamed over the real file, retrying while antivirus or the search indexer holds it;
 * - `serial()` runs a save function one call at a time (calls made meanwhile become one more run);
 * - `readJson()` keeps a damaged file aside instead of treating it as empty, so the next save
 *   can't overwrite what might still be recovered, and tells the caller it was damaged.
 */

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES'])
const DELAYS = [50, 100, 200, 400, 800, 1500]

let counter = 0
const tempName = (file) => `${file}.${process.pid}-${(counter++).toString(36)}.tmp`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to)
    } catch (err) {
      if (!BUSY.has(err?.code) || i >= DELAYS.length) throw err
      await sleep(DELAYS[i])
    }
  }
}

function renameRetrySync(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to)
    } catch (err) {
      if (!BUSY.has(err?.code) || i >= DELAYS.length) throw err
      sleepSync(DELAYS[i])
    }
  }
}

/** Writes `data` (string or Buffer) to `file` all at once or not at all. Throws on failure. */
async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = tempName(file)
  try {
    await fsp.writeFile(tmp, data, { flush: true })
    await renameRetry(tmp, file)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}

/** writeAtomic for quit time, when there's no event loop left to wait on. Throws on failure. */
function writeAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = tempName(file)
  try {
    fs.writeFileSync(tmp, data, { flush: true })
    renameRetrySync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw err
  }
}

/**
 * Wraps an async save so only one runs at a time. A call while one runs schedules exactly one more
 * run after it (so the newest data is always written last); the returned promise settles with the
 * run that covers the call.
 */
function serial(fn) {
  let current = null
  let queued = null
  const start = () => {
    current = Promise.resolve()
      .then(fn)
      .finally(() => {
        current = null
      })
    return current
  }
  return function run() {
    if (!current) return start()
    if (!queued) {
      queued = current
        .catch(() => {})
        .then(() => {
          queued = null
          return start()
        })
    }
    return queued
  }
}

/** Moves a damaged file aside as "<name>.damaged-<time>" so it isn't overwritten. Returns the new path or null. */
function keepAside(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const keptAs = `${file}.damaged-${stamp}`
  try {
    fs.renameSync(file, keptAs)
    return keptAs
  } catch {
    try {
      fs.copyFileSync(file, keptAs)
      return keptAs
    } catch {
      return null
    }
  }
}

/**
 * Reads a JSON file. Resolves to one of:
 *   { data }                 parsed
 *   { missing: true }        no file yet (first run)
 *   { corrupt: true, keptAs } it couldn't be parsed; the damaged file was moved aside
 *   { error }                it exists but couldn't be read (still locked after retries)
 * Callers must only start from empty on `missing` or `corrupt`; on `error` they shouldn't save
 * over the file during this session.
 */
async function readJson(file) {
  let text
  for (let i = 0; ; i++) {
    try {
      text = await fsp.readFile(file, 'utf8')
      break
    } catch (err) {
      if (err?.code === 'ENOENT') return { missing: true }
      if (!BUSY.has(err?.code) || i >= DELAYS.length) return { error: err }
      await sleep(DELAYS[i])
    }
  }
  try {
    return { data: JSON.parse(text) }
  } catch {
    return { corrupt: true, keptAs: keepAside(file) }
  }
}

/** readJson for start-up code that runs synchronously. */
function readJsonSync(file) {
  let text
  for (let i = 0; ; i++) {
    try {
      text = fs.readFileSync(file, 'utf8')
      break
    } catch (err) {
      if (err?.code === 'ENOENT') return { missing: true }
      if (!BUSY.has(err?.code) || i >= DELAYS.length) return { error: err }
      sleepSync(DELAYS[i])
    }
  }
  try {
    return { data: JSON.parse(text) }
  } catch {
    return { corrupt: true, keptAs: keepAside(file) }
  }
}

module.exports = { writeAtomic, writeAtomicSync, serial, readJson, readJsonSync, keepAside, renameRetry }
