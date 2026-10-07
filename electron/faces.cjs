const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { Worker } = require('node:worker_threads')
const { utilityProcess } = require('electron')

// Faceprints are InsightFace ArcFace (buffalo_l) embeddings: 512 numbers, L2-normalised, compared
// by cosine distance. Calibrated on test photos: copies of one face ~0.03 apart, the same person
// in different photos 0.32–0.48, clearly different people ≥ 0.69. (Immich uses 0.5 for this model.)
const MODEL = 'buffalo_l'
const DIMS = 512
const KEEP_SCORE = 0.5 // detector confidence to keep a face
const CLUSTER_SCORE = 0.7 // faces clear enough to define a person…
const CLUSTER_MIN_PX = 36 // …and big enough (in the 1024px analysis image)
const MAX_COS = 0.5 // faceprints closer than this belong to the same person
const MIN_FACES = 3 // a new person needs at least this many matching faces
const MERGE_COS = 0.3 // unnamed groups whose average faces are this close are one person
const PAIR_SUGGEST_COS = 0.6 // "Same person?" review
const MATCH_COS = 0.68 // "Possible matches" on a person's page (the user picks, so cast wider)
const CONCURRENCY = 4 // photos in flight (rendering overlaps with GPU inference)
const CLUSTER_EVERY = 300 // re-group after this many newly analysed photos with faces

const toEuclid = (cos) => Math.sqrt(2 * cos) // for unit vectors: |a-b|² = 2(1 - cos)
const CLUSTER_SRC = fs.readFileSync(path.join(__dirname, 'faces-cluster.cjs'), 'utf8')
const newPersonId = () => `p${crypto.randomBytes(5).toString('hex')}`

/** Faceprints are stored as int8 + a scale (≈ 4× smaller than float32, error < 0.1%). */
function encodeVec(v) {
  let max = 0
  for (const x of v) max = Math.max(max, Math.abs(x))
  const scale = max || 1
  const q = new Int8Array(v.length)
  for (let i = 0; i < v.length; i++) q[i] = Math.round((v[i] / scale) * 127)
  return { e: Buffer.from(q.buffer).toString('base64'), s: +scale.toPrecision(6) }
}
function decodeVec(e, s) {
  const q = new Int8Array(new Uint8Array(Buffer.from(e, 'base64')).buffer)
  const v = new Float32Array(q.length)
  let norm = 0
  for (let i = 0; i < q.length; i++) {
    v[i] = (q[i] / 127) * s
    norm += v[i] * v[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < v.length; i++) v[i] /= norm
  return v
}

/** Cosine distance between two directions (inputs need not be normalised). */
function cosDist(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let k = 0; k < a.length; k++) {
    dot += a[k] * b[k]
    na += a[k] * a[k]
    nb += b[k] * b[k]
  }
  return 1 - dot / (Math.sqrt(na * nb) || 1)
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[0] + a[2], b[0] + b[2])
  const y2 = Math.min(a[1] + a[3], b[1] + b[3])
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1)
}

function runClusterWorker(job) {
  return new Promise((resolve) => {
    // eval: works the same from inside the packaged app.asar
    const worker = new Worker(CLUSTER_SRC, { eval: true })
    worker.once('message', (result) => {
      resolve(result)
      worker.terminate()
    })
    worker.once('error', () => resolve(null))
    worker.postMessage(job, [job.desc.buffer, job.person.buffer, job.order.buffer])
  })
}

/** The InsightFace engine process (face-engine.cjs). Restarted automatically if it dies. */
class FaceEngine {
  constructor({ modelsDir, adapterFile }) {
    this.modelsDir = modelsDir
    this.adapterFile = adapterFile
    this.child = null
    this.ready = null
    this.info = null
    this.seq = 0
    this.pending = new Map()
  }

  start() {
    if (this.closed) return Promise.reject(new Error('The app is closing'))
    if (this.child) return this.ready
    const child = utilityProcess.fork(path.join(__dirname, 'face-engine.cjs'), [], {
      serviceName: 'Lumen face recognition',
      stdio: 'ignore',
    })
    this.child = child
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The face recognition engine did not start')), 120_000)
      child.on('message', (msg) => {
        if (msg.type === 'ready') {
          clearTimeout(timer)
          if (msg.error) return reject(new Error(msg.error))
          this.info = msg
          console.log(`[faces] engine ready on ${msg.device}${msg.adapter ?? ''}`, JSON.stringify(msg.timings))
          resolve(msg)
        } else if (msg.type === 'result') {
          const job = this.pending.get(msg.seq)
          if (!job) return
          this.pending.delete(msg.seq)
          clearTimeout(job.timer)
          job.resolve(msg)
        }
      })
    })
    this.ready.catch((err) => console.error(`[faces] engine failed to start: ${err.message}`))
    child.on('exit', () => {
      for (const [seq, job] of this.pending) {
        this.pending.delete(seq)
        clearTimeout(job.timer)
        job.resolve(null)
      }
      if (this.child === child) this.child = null
    })
    child.postMessage({ type: 'init', modelsDir: this.modelsDir, cacheFile: this.adapterFile })
    return this.ready
  }

  /** { ok, width, height, faces } — ok:false for an unreadable photo, null if the engine died. */
  async analyze(jpeg) {
    await this.start()
    const child = this.child
    if (!child) return null
    return new Promise((resolve) => {
      const seq = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        resolve({ ok: false, timeout: true })
      }, 60_000)
      this.pending.set(seq, { resolve, timer })
      child.postMessage({ type: 'analyze', seq, jpeg })
    })
  }

  dispose() {
    this.closed = true
    this.child?.kill()
    this.child = null
  }
}

/**
 * Finds faces in every photo, groups them into people and keeps the result (plus the user's
 * names, merges and corrections) in faces.json. Everything stays on this computer.
 */
class FaceIndex extends EventEmitter {
  constructor(file, { canRun, render, modelsDir, adapterFile }) {
    super()
    this.file = file
    this.canRun = canRun
    this.render = render // item -> Promise<JPEG Buffer> (1024px)
    this.items = new Map() // itemId -> { m: mtime, ar: aspect ratio, faces: [faceId] }
    this.faces = new Map() // faceId -> { id, item, box, score, px, d: Float32Array(512), person, rej: [], manual?, ignored? }
    this.people = new Map() // personId -> { id, name, hidden, created, cover?, notSame? }
    // From an older face model: per photo, the user's choices waiting to be carried over to the
    // faces the new model finds (matched by position) once that photo is re-analysed.
    this.legacy = new Map() // itemId -> [{ box, person?, rej?, manual?, ignored?, cover? }]
    this.photos = new Map() // itemId -> library item (images only)
    this.enabled = true
    this.halted = false
    this.error = null
    this.queue = []
    this.active = 0
    this.inflight = new Set() // photos being analysed right now (never queue them twice)
    this.sinceCluster = 0
    this.clustering = false
    this.clusterAgain = false
    this.edits = 0
    this.progress = { done: 0, total: 0 }
    this.engine = new FaceEngine({ modelsDir, adapterFile })
    this.timers = {}
  }

  // ---------- persistence ----------

  async load() {
    let data
    try {
      data = JSON.parse(await fsp.readFile(this.file, 'utf8'))
    } catch {
      return
    }
    if (data.version === 2 && data.model === MODEL) {
      for (const [id, rec] of Object.entries(data.items)) this.items.set(id, rec)
      for (const f of data.faces) {
        this.faces.set(f.id, { ...f, d: decodeVec(f.e, f.s), rej: f.rej || [], e: undefined, s: undefined, enc: { e: f.e, s: f.s } })
      }
      for (const p of data.people) this.people.set(p.id, p)
      for (const [id, list] of Object.entries(data.legacy ?? {})) this.legacy.set(id, list)
    } else if (data.version === 1) {
      this.migrateFromV1(data)
    }
  }

  /**
   * v1 used face-api's 128-number faceprints, which can't be compared with ArcFace's. Every photo
   * is analysed again; what the user decided is kept: named/hidden people, faces they moved by
   * hand, "not this person" corrections and removed people. Unnamed automatic groups are rebuilt
   * by the new model (which groups far more accurately).
   */
  migrateFromV1(data) {
    const people = new Map(data.people.map((p) => [p.id, p]))
    const manualOwners = new Set(data.faces.filter((f) => f.manual && f.person).map((f) => f.person))
    const keep = new Set([...people.values()].filter((p) => p.name || p.hidden || manualOwners.has(p.id)).map((p) => p.id))
    for (const id of keep) {
      const p = people.get(id)
      this.people.set(id, { ...p, notSame: p.notSame?.filter((x) => keep.has(x)), cover: undefined })
    }
    for (const f of data.faces) {
      const t = { box: f.box, ar: data.items[f.item]?.ar ?? 1 }
      if (f.person && keep.has(f.person)) {
        t.person = f.person
        if (f.manual) t.manual = true
        if (people.get(f.person)?.cover === f.id) t.cover = true
      }
      const rej = (f.rej ?? []).filter((p) => keep.has(p))
      if (rej.length) t.rej = rej
      if (f.ignored) t.ignored = true
      if (t.person || t.rej || t.ignored) {
        if (!this.legacy.has(f.item)) this.legacy.set(f.item, [])
        this.legacy.get(f.item).push(t)
      }
    }
    this.migrated = true
    console.log(`[faces] upgrading from face-api: keeping ${keep.size} people, ${this.legacy.size} photos with choices to carry over`)
  }

  serialize() {
    return JSON.stringify({
      version: 2,
      model: MODEL,
      items: Object.fromEntries(this.items),
      faces: [...this.faces.values()].map((f) => {
        f.enc ??= encodeVec(f.d) // encoded once, not on every save
        return {
          id: f.id,
          item: f.item,
          box: f.box,
          score: f.score,
          px: f.px,
          e: f.enc.e,
          s: f.enc.s,
          person: f.person,
          rej: f.rej.length ? f.rej : undefined,
          manual: f.manual || undefined,
          ignored: f.ignored || undefined,
        }
      }),
      people: [...this.people.values()],
      legacy: this.legacy.size ? Object.fromEntries(this.legacy) : undefined,
    })
  }

  /** Throttled: at most one write per `ms` while analysing; user edits ask for a quicker save. */
  saveSoon(ms = 15_000) {
    const due = Date.now() + ms
    if (this.timers.save && this.saveDue <= due) return
    clearTimeout(this.timers.save)
    this.saveDue = due
    this.timers.save = setTimeout(() => this.save(), ms)
  }

  async save() {
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      const tmp = `${this.file}.tmp`
      await fsp.writeFile(tmp, this.serialize())
      await fsp.rename(tmp, this.file)
    } catch (err) {
      console.error('Failed to save faces', err)
    }
  }

  saveNow() {
    if (!this.timers.save && !this.migrated) return
    clearTimeout(this.timers.save)
    this.timers.save = null
    try {
      fs.writeFileSync(this.file, this.serialize())
      this.migrated = false
    } catch {}
  }

  // ---------- pipeline ----------

  /** Reconcile with the library: forget removed/changed photos, queue new ones (newest first). */
  sync(libraryItems) {
    this.photos = new Map(libraryItems.filter((it) => it.type === 'image').map((it) => [it.id, it]))
    let dropped = false
    for (const [id, rec] of this.items) {
      const it = this.photos.get(id)
      if (!it || it.mtime !== rec.m) {
        this.dropItem(id)
        dropped = true
      }
    }
    for (const id of this.legacy.keys()) if (!this.photos.has(id)) this.legacy.delete(id)
    if (dropped) {
      this.prunePeople()
      this.changed()
      this.saveSoon()
    }
    if (this.migrated) {
      this.saveSoon(2000)
      this.changed()
    }
    this.queue = [...this.photos.values()]
      .filter((it) => !this.items.has(it.id) && !this.inflight.has(it.id))
      .sort((a, b) => b.date - a.date)
      .map((it) => it.id)
    this.progress = { done: 0, total: this.queue.length }
    this.emitProgress()
    this.pump()
  }

  pump() {
    if (!this.enabled || this.halted || this.disposed || !this.canRun()) return
    while (this.active < CONCURRENCY && this.queue.length) {
      const item = this.photos.get(this.queue.shift())
      if (!item || this.items.has(item.id) || this.inflight.has(item.id)) continue
      this.active++
      this.inflight.add(item.id)
      this.analyze(item).finally(() => {
        this.active--
        this.inflight.delete(item.id)
        this.progress.done++
        this.emitProgress()
        this.pump()
      })
    }
    if (!this.queue.length && !this.active && this.sinceCluster > 0) this.cluster()
  }

  async analyze(item) {
    let res
    try {
      const jpeg = await this.render(item)
      res = jpeg ? await this.engine.analyze(jpeg) : { ok: false }
    } catch (err) {
      // The engine itself couldn't start (e.g. models missing). Stop instead of failing every photo.
      this.halted = true
      this.error = String(err?.message || err)
      this.queue.unshift(item.id)
      this.progress.done--
      this.emitProgress()
      return
    }
    if (!res) {
      this.queue.push(item.id) // engine restarted; try again later
      this.progress.done--
      return
    }
    // changed while we were busy, or already analysed: never overwrite faces (and the user's choices)
    if (this.photos.get(item.id) !== item || this.items.has(item.id)) return
    const added = []
    if (res.ok) {
      res.faces.forEach((f, i) => {
        if (f.score < KEEP_SCORE) return
        const face = {
          id: `${item.id}:${i}`,
          item: item.id,
          box: f.box.map((v) => +v.toFixed(4)),
          score: +f.score.toFixed(3),
          px: Math.round(Math.min(f.box[2] * res.width, f.box[3] * res.height)),
          d: f.embedding instanceof Float32Array ? f.embedding : Float32Array.from(f.embedding),
          person: null,
          rej: [],
        }
        this.faces.set(face.id, face)
        added.push(face)
      })
    }
    this.carryOver(item.id, added)
    this.items.set(item.id, { m: item.mtime, ar: res.ok ? +(res.width / res.height).toFixed(4) : 1, faces: added.map((f) => f.id) })
    if (added.length) this.sinceCluster++
    if (this.sinceCluster >= CLUSTER_EVERY) this.cluster()
    this.saveSoon()
  }

  /** Give newly found faces the user's earlier choices for the same face (matched by position). */
  carryOver(itemId, faces) {
    const old = this.legacy.get(itemId)
    if (!old) return
    this.legacy.delete(itemId)
    const taken = new Set()
    for (const t of old) {
      let best = null
      let bestIou = 0.3
      for (const f of faces) {
        const v = iou(t.box, f.box)
        if (v > bestIou && !taken.has(f)) {
          best = f
          bestIou = v
        }
      }
      if (!best) continue
      taken.add(best)
      if (t.person && this.people.has(t.person)) {
        best.person = t.person
        if (t.manual) best.manual = true
        if (t.cover) this.people.get(t.person).cover = best.id
      }
      if (t.rej) best.rej = t.rej.filter((p) => this.people.has(p))
      if (t.ignored) best.ignored = true
    }
    this.changed()
  }

  async cluster() {
    if (this.clustering) {
      this.clusterAgain = true
      return
    }
    this.clustering = true
    this.sinceCluster = 0
    const faces = [...this.faces.values()]
    const personIds = [...this.people.keys()]
    const personIndex = new Map(personIds.map((p, i) => [p, i]))
    const n = faces.length
    const desc = new Float32Array(n * DIMS)
    const eligible = new Uint8Array(n)
    const person = new Int32Array(n).fill(-1)
    const rejected = new Array(n)
    faces.forEach((f, i) => {
      desc.set(f.d, i * DIMS)
      // Faces from a person the user removed ("ignored") never seed or join a group by themselves.
      eligible[i] = !f.ignored && f.score >= CLUSTER_SCORE && f.px >= CLUSTER_MIN_PX ? 1 : 0
      if (f.person && personIndex.has(f.person)) {
        person[i] = personIndex.get(f.person)
        eligible[i] = 1
      }
      if (f.rej.length) rejected[i] = f.rej.map((p) => personIndex.get(p)).filter((v) => v !== undefined)
    })
    const quality = (f) => f.score * f.px
    const order = Int32Array.from([...faces.keys()].sort((a, b) => quality(faces[b]) - quality(faces[a])))
    const edits = this.edits

    const result = await runClusterWorker({
      dims: DIMS,
      desc,
      eligible,
      person,
      rejected,
      order,
      nextPerson: personIds.length,
      maxDist: toEuclid(MAX_COS),
      minFaces: MIN_FACES,
    })
    this.clustering = false

    if (result && edits === this.edits) {
      const created = new Map()
      result.person.forEach((p, i) => {
        const f = faces[i]
        if (p < 0 || f.person || this.faces.get(f.id) !== f) return
        let pid = personIds[p]
        if (pid === undefined) {
          pid = created.get(p)
          if (!pid) {
            pid = newPersonId()
            created.set(p, pid)
            this.people.set(pid, { id: pid, name: '', hidden: false, created: Date.now() })
          }
        }
        if (this.people.has(pid)) f.person = pid
      })
      this.mergeDuplicates()
      this.prunePeople()
      this.changed()
      this.saveSoon()
    }
    if (this.clusterAgain || (result && edits !== this.edits)) {
      this.clusterAgain = false
      this.cluster()
    }
  }

  /** Two unnamed groups that are really the same person get folded together. */
  mergeDuplicates() {
    const cents = this.centroids(true)
    const refused = new Map() // person -> people its faces were removed from
    for (const f of this.faces.values()) {
      if (!f.person || !f.rej.length) continue
      let r = refused.get(f.person)
      if (!r) refused.set(f.person, (r = new Set()))
      for (const p of f.rej) r.add(p)
    }
    // Never fold a group back into someone the user said it isn't (or marked "not the same").
    const conflict = (a, b) => refused.get(a)?.has(b) || refused.get(b)?.has(a) || this.isNotSame(a, b)
    const sizes = new Map()
    for (const f of this.faces.values()) if (f.person) sizes.set(f.person, (sizes.get(f.person) ?? 0) + 1)
    const groups = [...cents].map(([pid, v]) => ({ pid, v, n: sizes.get(pid) ?? 0 })).sort((a, b) => b.n - a.n)
    const into = new Map()
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i]
        const b = groups[j]
        if (into.has(a.pid) || into.has(b.pid) || this.people.get(b.pid)?.name || conflict(a.pid, b.pid)) continue
        if (cosDist(a.v, b.v) < MERGE_COS) into.set(b.pid, a.pid)
      }
    }
    for (const f of this.faces.values()) if (into.has(f.person)) f.person = into.get(f.person)
  }

  prunePeople() {
    const used = new Set()
    for (const f of this.faces.values()) if (f.person) used.add(f.person)
    for (const list of this.legacy.values()) for (const t of list) if (t.person) used.add(t.person)
    for (const pid of this.people.keys()) if (!used.has(pid)) this.people.delete(pid)
  }

  dropItem(id) {
    for (const faceId of this.items.get(id)?.faces ?? []) this.faces.delete(faceId)
    this.items.delete(id)
  }

  // ---------- user actions ----------

  edited() {
    this.edits++
    this.prunePeople()
    this.changed()
    this.saveSoon(1500)
  }

  rename(pid, name) {
    const p = this.people.get(pid)
    if (!p) return
    p.name = String(name || '').trim().slice(0, 60)
    this.edited()
  }

  setHidden(pid, hidden) {
    const p = this.people.get(pid)
    if (!p) return
    p.hidden = !!hidden
    this.edited()
  }

  setHiddenMany(ids, hidden) {
    for (const id of ids) {
      const p = this.people.get(id)
      if (p) p.hidden = !!hidden
    }
    this.edited()
  }

  merge(fromIds, intoId) {
    const into = this.people.get(intoId)
    if (!into) return
    for (const pid of fromIds) {
      const from = this.people.get(pid)
      if (!from || pid === intoId) continue
      if (!into.name && from.name) into.name = from.name
      if (from.notSame?.length) into.notSame = [...new Set([...(into.notSame ?? []), ...from.notSame])].filter((p) => p !== intoId)
      const swap = (list) => [...new Set(list.map((p) => (p === pid ? intoId : p)))]
      for (const f of this.faces.values()) {
        if (f.person === pid) f.person = intoId
        // "not <from>" now means "not <into>": they're the same person
        if (f.rej.includes(pid)) f.rej = swap(f.rej)
      }
      for (const list of this.legacy.values()) {
        for (const t of list) {
          if (t.person === pid) t.person = intoId
          if (t.rej?.includes(pid)) t.rej = swap(t.rej)
        }
      }
      for (const p of this.people.values()) if (p.notSame?.includes(pid)) p.notSame = swap(p.notSame)
      this.people.delete(pid)
    }
    this.edited()
  }

  /** "Not this person": take these photos out of a person and keep them out. */
  reject(pid, itemIds) {
    const items = new Set(itemIds)
    const ids = []
    for (const f of this.faces.values()) if (f.person === pid && items.has(f.item)) ids.push(f.id)
    this.rejectFaces(ids)
  }

  /** Take faces out of whoever they're assigned to, and never put them back there automatically. */
  rejectFaces(faceIds) {
    for (const id of faceIds) {
      const f = this.faces.get(id)
      if (!f?.person) continue
      if (!f.rej.includes(f.person)) f.rej.push(f.person)
      f.person = null
      f.manual = undefined
    }
    this.edited()
    this.cluster() // the removed faces may belong to someone else
  }

  /**
   * Put faces into a person by hand ("Move to…", "Who's this?"). `target` is a person id, or
   * { name } to create a new person. Returns the person id.
   */
  assignFaces(faceIds, target) {
    let pid = typeof target === 'string' ? target : null
    if (!pid) {
      pid = newPersonId()
      this.people.set(pid, { id: pid, name: String(target?.name || '').trim().slice(0, 60), hidden: false, created: Date.now() })
    }
    const person = this.people.get(pid)
    if (!person) return null
    for (const id of faceIds) {
      const f = this.faces.get(id)
      if (!f || f.person === pid) continue
      if (f.person && !f.rej.includes(f.person)) f.rej.push(f.person) // don't drift back
      f.rej = f.rej.filter((p) => p !== pid)
      f.person = pid
      f.manual = true
      f.ignored = undefined
    }
    this.edited()
    return pid
  }

  setCover(pid, faceId) {
    const p = this.people.get(pid)
    if (!p || this.faces.get(faceId)?.person !== pid) return
    p.cover = faceId
    this.edited()
  }

  /** Forget a person: their faces are ungrouped and left out of automatic grouping. */
  removePerson(pid) {
    for (const f of this.faces.values()) {
      if (f.person !== pid) continue
      f.person = null
      f.ignored = true
    }
    for (const list of this.legacy.values()) {
      for (const t of list) {
        if (t.person !== pid) continue
        t.person = undefined
        t.ignored = true
      }
    }
    this.people.delete(pid)
    this.edited()
  }

  /** "Different people": never suggest or auto-merge these two again. */
  markNotSame(a, b) {
    const pa = this.people.get(a)
    const pb = this.people.get(b)
    if (!pa || !pb || a === b) return
    pa.notSame = [...new Set([...(pa.notSame ?? []), b])]
    pb.notSame = [...new Set([...(pb.notSame ?? []), a])]
    this.edited()
  }

  isNotSame(a, b) {
    return !!(this.people.get(a)?.notSame?.includes(b) || this.people.get(b)?.notSame?.includes(a))
  }

  removeItems(ids) {
    for (const id of ids) {
      this.dropItem(id)
      this.legacy.delete(id)
    }
    this.edited()
  }

  setEnabled(enabled) {
    this.enabled = enabled
    if (enabled) {
      this.halted = false
      this.error = null
      this.pump()
    } else {
      this.queue = []
      this.progress = { done: 0, total: 0 }
    }
    this.emitProgress()
    this.changed()
  }

  async reset() {
    this.items.clear()
    this.faces.clear()
    this.people.clear()
    this.legacy.clear()
    this.edits++
    await fsp.rm(this.file, { force: true }).catch(() => {})
    this.changed()
    if (this.enabled) this.sync([...this.photos.values()])
  }

  // ---------- similarity ----------

  /** Average faceprint direction of every person (cached until something changes). */
  centroids(fresh = false) {
    const key = `${this.edits}:${this.faces.size}`
    if (!fresh && this.centroidCache?.key === key) return this.centroidCache.map
    const sums = new Map()
    for (const f of this.faces.values()) {
      if (!f.person) continue
      let v = sums.get(f.person)
      if (!v) sums.set(f.person, (v = new Float64Array(DIMS)))
      for (let k = 0; k < DIMS; k++) v[k] += f.d[k]
    }
    this.centroidCache = { key, map: sums }
    return sums
  }

  /** People who look most like `pid` (candidates to merge), closest first. */
  matches(pid, limit = 40) {
    const cents = this.centroids()
    const c = cents.get(pid)
    if (!c) return []
    const out = []
    for (const [other, v] of cents) {
      if (other === pid || this.people.get(other)?.hidden || this.isNotSame(pid, other)) continue
      const d = cosDist(c, v)
      if (d < MATCH_COS) out.push({ id: other, distance: +d.toFixed(3) })
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, limit)
  }

  /** Pairs of groups that are probably the same person, most likely first. */
  suggestions(limit = 300) {
    const cents = [...this.centroids()].filter(([pid]) => !this.people.get(pid)?.hidden)
    const out = []
    for (let i = 0; i < cents.length; i++) {
      for (let j = i + 1; j < cents.length; j++) {
        const d = cosDist(cents[i][1], cents[j][1])
        if (d < PAIR_SUGGEST_COS && !this.isNotSame(cents[i][0], cents[j][0])) {
          out.push({ a: cents[i][0], b: cents[j][0], distance: +d.toFixed(3) })
        }
      }
    }
    return out.sort((x, y) => x.distance - y.distance).slice(0, limit)
  }

  // ---------- output ----------

  changed() {
    clearTimeout(this.timers.changed)
    this.timers.changed = setTimeout(() => this.emit('changed'), 300)
  }

  emitProgress() {
    if (this.timers.progress) return
    this.timers.progress = setTimeout(() => {
      this.timers.progress = null
      this.emit('progress', this.progressInfo())
    }, 300)
  }

  progressInfo() {
    const running = this.enabled && !this.halted && (this.active > 0 || this.queue.length > 0)
    return {
      ...this.progress,
      running,
      error: this.error,
      upgrading: this.legacy.size > 0,
      engine: this.engine.info ? { device: this.engine.info.device, adapter: this.engine.info.adapter } : null,
    }
  }

  /**
   * Everything the UI needs: people (with a cover face) and every face in every photo as
   * [faceId, personId | null, x, y, w, h, distance from the person's average face].
   */
  snapshot() {
    const cents = this.centroids()
    const stats = new Map()
    const byItem = {}
    const count = (pid, face, itemId) => {
      let s = stats.get(pid)
      if (!s) stats.set(pid, (s = { items: new Set(), cover: null, fallback: null }))
      s.items.add(itemId)
      if (face && (!s.cover || face.score * face.px > s.cover.score * s.cover.px)) s.cover = face
      return s
    }
    for (const f of this.faces.values()) {
      if (f.ignored && !f.person) continue
      const pid = f.person && this.people.has(f.person) ? f.person : null
      const entry = (byItem[f.item] ??= { ar: this.items.get(f.item)?.ar ?? 1, faces: [] })
      let dist = 0
      if (pid) {
        count(pid, f, f.item)
        const c = cents.get(pid)
        if (c) dist = +cosDist(f.d, c).toFixed(3)
      } else if (f.score < CLUSTER_SCORE || f.px < CLUSTER_MIN_PX) {
        continue // tiny/blurry strangers in the background: not worth a "Who's this?" chip
      }
      entry.faces.push([f.id, pid, ...f.box, dist])
    }
    // While upgrading from an older model, named people keep showing their not-yet-re-analysed
    // photos (display only).
    for (const [itemId, list] of this.legacy) {
      list.forEach((t, i) => {
        if (!t.person || !this.people.has(t.person)) return
        const id = `old:${itemId}:${i}`
        const s = count(t.person, null, itemId)
        s.fallback ??= { face: id, item: itemId, box: t.box, ar: t.ar ?? 1 }
        const entry = (byItem[itemId] ??= { ar: t.ar ?? 1, faces: [] })
        entry.faces.push([id, t.person, ...t.box, 0])
      })
    }
    const people = []
    for (const [pid, s] of stats) {
      const p = this.people.get(pid)
      const chosen = p.cover && this.faces.get(p.cover)
      const cover = chosen?.person === pid ? chosen : s.cover
      people.push({
        id: pid,
        name: p.name,
        hidden: p.hidden,
        count: s.items.size,
        cover: cover
          ? { face: cover.id, item: cover.item, box: cover.box, ar: this.items.get(cover.item)?.ar ?? 1 }
          : s.fallback, // only old-model faces so far (upgrade in progress)
      })
    }
    people.sort((a, b) => Number(!!b.name) - Number(!!a.name) || b.count - a.count)
    return {
      enabled: this.enabled,
      people,
      byItem,
      analysed: this.items.size,
      faces: this.faces.size,
    }
  }

  dispose() {
    this.disposed = true
    this.queue = []
    this.saveNow()
    this.engine.dispose()
  }
}

module.exports = { FaceIndex }
