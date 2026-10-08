const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { replaceWithTemp } = require('./jpeg-exif.cjs')

// Star ratings and tags (keywords) inside JPEG photos, written the way Windows File Explorer writes
// them so Explorer, Lightroom, digiKam… all see the same values. Lossless: only header segments
// change, the compressed picture (SOS…EOI and anything after it) is copied byte for byte.
//
// What Windows writes (measured with the Windows Property System on Windows 11):
//   XMP   xmp:Rating 1–5, MicrosoftPhoto:Rating 1/25/50/75/99, dc:subject bag,
//         MicrosoftPhoto:LastKeywordXMP bag (+ LastKeywordIPTC when the photo has IPTC)
//   EXIF  IFD0 0x4746 Rating, 0x4749 RatingPercent, 0x9C9E XPKeywords ("a;b" in UTF-16)
//   IPTC  2:25 Keywords, when the photo already has an IPTC block
// What Explorer reads: Rating = MicrosoftPhoto:Rating, else EXIF RatingPercent, else xmp:Rating
// (percent → stars: 1–12 ★, 13–37 ★★, 38–62 ★★★, 63–87 ★★★★, 88–99 ★★★★★). Tags = dc:subject
// plus EXIF XPKeywords and IPTC Keywords, except those it wrote itself (LastKeyword*) and that
// were since removed from dc:subject. So every source is kept in step here; clearing removes them.
//
// Other formats (HEIC, PNG, RAW, videos) are never modified; an optional XMP sidecar
// (Lightroom style "<name>.xmp") can hold their rating and tags.

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  x: 'adobe:ns:meta/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  dc: 'http://purl.org/dc/elements/1.1/',
  ms: 'http://ns.microsoft.com/photo/1.0/',
}
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0'
const MAX_SEGMENT = 0xffff - 2 // bytes after the length field's own two
const TAG_RATING = 0x4746
const TAG_RATING_PERCENT = 0x4749
const TAG_XP_KEYWORDS = 0x9c9e
const BYTE = 1
const SHORT = 3
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }

const MSG = {
  notJpeg: 'Only JPEG photos can hold ratings and tags inside the file.',
  invalid: 'Not a valid JPEG file.',
  xmp: "The photo's existing XMP data couldn't be read, so it was left alone.",
  tooBig: 'Too many tags to fit inside the photo.',
  layout: "This photo's layout can't be updated safely.",
  busy: 'The photo is open in another program. Close it and try again.',
}

// ── ratings & tags ───────────────────────────────────────────────────────────

const PERCENT = [0, 1, 25, 50, 75, 99]

/** 0–5 (anything else, e.g. Lightroom's −1 "rejected", counts as unrated). */
const cleanRating = (n) => {
  const v = Math.round(Number(n))
  return Number.isFinite(v) && v >= 1 && v <= 5 ? v : 0
}
/** Stars → the percent Windows stores (MicrosoftPhoto:Rating, EXIF RatingPercent). */
const starsToPercent = (stars) => PERCENT[cleanRating(stars)]
/** Percent → stars, with Explorer's own thresholds. */
function percentToStars(p) {
  const v = Number(p)
  if (!Number.isFinite(v) || v <= 0) return 0
  return v <= 12 ? 1 : v <= 37 ? 2 : v <= 62 ? 3 : v <= 87 ? 4 : 5
}

/** A tag as stored: trimmed, single spaces, no ";" (Windows' separator), at most 64 characters. */
const cleanTag = (t) =>
  String(t ?? '')
    .replace(/[;\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim()

/** Clean, non-empty, case-insensitively unique (the first spelling wins). */
function cleanTags(list) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const t = cleanTag(raw)
    const k = t.toLowerCase()
    if (!t || seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

const sameTags = (a, b) => a.length === b.length && a.every((t, i) => t === b[i])
const splitXp = (s) => cleanTags(String(s ?? '').split(';'))
const asList = (v) => (v == null ? undefined : (Array.isArray(v) ? v : [v]).map(String))

/**
 * Combines what a file says, the way Explorer does. Every input may be undefined (absent).
 * Returns { rating?: 0–5, tags?: string[] }: a field is missing when the file has nothing for it.
 * Rating: xmp:Rating first (the standard, and what Lightroom/digiKam update), then Windows'
 * MicrosoftPhoto:Rating, then EXIF. Tags: dc:subject plus EXIF/IPTC keywords that Windows didn't
 * write itself (LastKeyword*), so a tag removed elsewhere doesn't come back.
 */
function combine({ xmpRating, msRating, exifRating, exifPercent, subject, lastXmp, lastIptc, xp, iptc } = {}) {
  const out = {}
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v))
  if (num(xmpRating) !== undefined) out.rating = cleanRating(xmpRating)
  else if (num(msRating) !== undefined) out.rating = percentToStars(msRating)
  else if (num(exifRating) !== undefined && num(exifRating) > 0) out.rating = cleanRating(exifRating)
  else if (num(exifPercent) !== undefined) out.rating = percentToStars(exifPercent)
  else if (num(exifRating) !== undefined) out.rating = 0

  const has = (list, t) => !!list?.some((x) => x.toLowerCase() === t.toLowerCase())
  const minus = (list, wrote) => (list ?? []).filter((t) => !wrote || !has(wrote, t))
  if (subject !== undefined) out.tags = cleanTags([...subject, ...minus(xp, lastXmp), ...minus(iptc, lastIptc)])
  else if (xp !== undefined || iptc !== undefined) out.tags = cleanTags([...(iptc ?? []), ...(xp ?? [])])
  return out
}

// ── a small XML reader that keeps source offsets (edits are splices on the original text) ──

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return XML_ENT[e.toLowerCase()] ?? m
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
const escapeXml = (s, attr = false) => {
  const t = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return attr ? t.replace(/"/g, '&quot;') : t
}

const NAME = /[^\s=/>"'<!?]+/y
const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t'
const BASE_NS = new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])

/**
 * Parses well-formed XML into elements { name, start, openEnd, end, closeStart, selfClosing,
 * slash, attrs: [{ name, value, start, end, valueStart, valueEnd }], children, ns } and text
 * nodes { text: true, start, end, cdata }. Returns null when the text isn't well-formed.
 */
function parseXml(s) {
  const root = { name: '#root', children: [], ns: BASE_NS, attrs: [] }
  const stack = [root]
  let i = 0
  while (i < s.length) {
    const top = stack[stack.length - 1]
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      top.children.push({ text: true, start: i, end: s.length })
      break
    }
    if (lt > i) top.children.push({ text: true, start: i, end: lt })
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4)
      if (e < 0) return null
      i = e + 3
      continue
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9)
      if (e < 0) return null
      top.children.push({ text: true, cdata: true, start: lt, end: e + 3 })
      i = e + 3
      continue
    }
    if (s[lt + 1] === '?') {
      const e = s.indexOf('?>', lt + 2)
      if (e < 0) return null
      i = e + 2
      continue
    }
    if (s[lt + 1] === '!') {
      if (s.slice(lt, lt + 200).includes('[')) return null // DTD internal subsets: not in XMP
      const e = s.indexOf('>', lt + 2)
      if (e < 0) return null
      i = e + 1
      continue
    }
    if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt + 2)
      if (e < 0 || stack.length < 2 || s.slice(lt + 2, e).trim() !== top.name) return null
      top.closeStart = lt
      top.end = e + 1
      stack.pop()
      i = e + 1
      continue
    }
    NAME.lastIndex = lt + 1
    const m = NAME.exec(s)
    if (!m) return null
    const el = { name: m[0], start: lt, attrs: [], children: [], selfClosing: false, slash: -1, openEnd: 0, closeStart: -1, end: 0, ns: top.ns, parent: top }
    let p = NAME.lastIndex
    for (;;) {
      const ws = p
      while (p < s.length && isWs(s[p])) p++
      if (p >= s.length) return null
      if (s[p] === '>') {
        el.openEnd = p + 1
        break
      }
      if (s[p] === '/' && s[p + 1] === '>') {
        el.selfClosing = true
        el.slash = p
        el.openEnd = p + 2
        break
      }
      if (p === ws) return null
      NAME.lastIndex = p
      const a = NAME.exec(s)
      if (!a) return null
      p = NAME.lastIndex
      while (isWs(s[p])) p++
      if (s[p] !== '=') return null
      p++
      while (isWs(s[p])) p++
      const q = s[p]
      if (q !== '"' && q !== "'") return null
      const close = s.indexOf(q, p + 1)
      if (close < 0) return null
      el.attrs.push({ name: a[0], start: ws, end: close + 1, valueStart: p + 1, valueEnd: close, value: decodeXml(s.slice(p + 1, close)) })
      p = close + 1
    }
    const decl = el.attrs.filter((a) => a.name === 'xmlns' || a.name.startsWith('xmlns:'))
    if (decl.length) {
      el.ns = new Map(top.ns)
      for (const a of decl) el.ns.set(a.name === 'xmlns' ? '' : a.name.slice(6), a.value)
    }
    top.children.push(el)
    if (el.selfClosing) el.end = el.openEnd
    else stack.push(el)
    i = el.openEnd
  }
  return stack.length === 1 ? root : null
}

const splitName = (name) => {
  const c = name.indexOf(':')
  return c < 0 ? ['', name] : [name.slice(0, c), name.slice(c + 1)]
}
const elIs = (el, uri, local) => {
  if (el.text) return false
  const [p, l] = splitName(el.name)
  return l === local && el.ns.get(p) === uri
}
const attrIs = (el, a, uri, local) => {
  const [p, l] = splitName(a.name)
  return p !== '' && p !== 'xmlns' && l === local && el.ns.get(p) === uri
}
/** A prefix bound to `uri` at this element ('' for a default namespace), or undefined. */
const prefixOf = (el, uri, allowDefault = false) => {
  for (const [p, u] of el.ns) if (u === uri && (p !== '' || allowDefault)) return p
  return undefined
}

function findRdf(node) {
  for (const c of node.children ?? []) {
    if (c.text) continue
    if (elIs(c, NS.rdf, 'RDF')) return c
    const inner = findRdf(c)
    if (inner) return inner
  }
  return null
}

/** Text content of an element (its own text and CDATA, not nested elements). */
const textOf = (s, el) =>
  el.children
    .filter((c) => c.text)
    .map((c) => (c.cdata ? s.slice(c.start + 9, c.end - 3) : decodeXml(s.slice(c.start, c.end))))
    .join('')
    .trim()

/** The items of an rdf:Bag / Seq / Alt property (or its plain text as one item). */
function listOf(s, el) {
  const container = el.children.find((c) => elIs(c, NS.rdf, 'Bag') || elIs(c, NS.rdf, 'Seq') || elIs(c, NS.rdf, 'Alt'))
  if (!container) {
    const t = textOf(s, el)
    return t ? [t] : []
  }
  return container.children.filter((c) => elIs(c, NS.rdf, 'li')).map((li) => textOf(s, li)).filter(Boolean)
}

const READ_PROPS = [
  ['xmpRating', NS.xmp, 'Rating', false],
  ['msRating', NS.ms, 'Rating', false],
  ['subject', NS.dc, 'subject', true],
  ['lastXmp', NS.ms, 'LastKeywordXMP', true],
  ['lastIptc', NS.ms, 'LastKeywordIPTC', true],
]

/** The rating/keyword properties of an XMP packet; null when it isn't well-formed XML. */
function readXmp(xml) {
  if (typeof xml !== 'string') return null
  const doc = parseXml(xml)
  if (!doc) return null
  const rdf = findRdf(doc)
  const out = {}
  if (!rdf) return out
  for (const d of rdf.children) {
    if (!elIs(d, NS.rdf, 'Description')) continue
    for (const [key, uri, local, isList] of READ_PROPS) {
      if (out[key] !== undefined) continue
      const a = d.attrs.find((x) => attrIs(d, x, uri, local))
      if (a) out[key] = isList ? (a.value.trim() ? [a.value.trim()] : []) : a.value.trim()
      const c = d.children.find((x) => elIs(x, uri, local))
      if (c && out[key] === undefined) out[key] = isList ? listOf(xml, c) : textOf(xml, c)
    }
  }
  return out
}

const lineIndent = (s, pos) => {
  let p = pos
  while (p > 0 && (s[p - 1] === ' ' || s[p - 1] === '\t')) p--
  return p === 0 || s[p - 1] === '\n' || s[p - 1] === '\r' ? s.slice(p, pos) : ''
}
/** Start of the whitespace run right before `pos` (to remove an element with its line). */
const wsBefore = (s, pos) => {
  let p = pos
  while (p > 0 && isWs(s[p - 1])) p--
  return p
}

function propXml(qname, value, rdfPrefix, indent) {
  if (!Array.isArray(value)) return `<${qname}>${escapeXml(value)}</${qname}>`
  const r = rdfPrefix ? `${rdfPrefix}:` : ''
  const items = value.map((t) => `${indent}  <${r}li>${escapeXml(t)}</${r}li>\n`).join('')
  return `<${qname}>\n${indent} <${r}Bag>\n${items}${indent} </${r}Bag>\n${indent}</${qname}>`
}

/**
 * Sets properties in an XMP document, preserving everything else byte for byte.
 * `sets`: [{ uri, local, prefix, value }] where value is a string, an array (a bag) or null to
 * remove. The first existing occurrence is replaced in place; others are removed; missing ones are
 * added to the rdf:Description that already declares the namespace (else the first one).
 * Returns the new text, or null when the XML can't be read.
 */
function editXmp(xml, sets) {
  const doc = parseXml(xml)
  if (!doc) return null
  const rdf = findRdf(doc)
  if (!rdf || rdf.selfClosing) return null
  const descs = rdf.children.filter((c) => elIs(c, NS.rdf, 'Description'))
  const splices = []
  const additions = new Map() // description (or null = a new one) → { props: [], ns: Map(prefix → uri) }

  for (const set of sets) {
    const empty = set.value == null || (Array.isArray(set.value) && !set.value.length)
    let done = empty
    for (const d of descs) {
      for (const a of d.attrs) {
        if (!attrIs(d, a, set.uri, set.local)) continue
        if (!done && !Array.isArray(set.value)) {
          splices.push({ at: a.valueStart, end: a.valueEnd, text: escapeXml(set.value, true) })
          done = true
        } else splices.push({ at: a.start, end: a.end, text: '' })
      }
      for (const c of d.children) {
        if (!elIs(c, set.uri, set.local)) continue
        if (!done) {
          splices.push({ at: c.start, end: c.end, text: propXml(c.name, set.value, prefixOf(c, NS.rdf, true), lineIndent(xml, c.start)) })
          done = true
        } else splices.push({ at: wsBefore(xml, c.start), end: c.end, text: '' })
      }
    }
    if (done) continue
    const d = descs.find((x) => prefixOf(x, set.uri) !== undefined) ?? descs[0] ?? null
    if (!additions.has(d)) additions.set(d, { props: [], ns: new Map() })
    const add = additions.get(d)
    let prefix = d ? prefixOf(d, set.uri) : undefined
    if (prefix === undefined) prefix = [...add.ns].find(([, u]) => u === set.uri)?.[0]
    if (prefix === undefined) {
      prefix = set.prefix
      for (let n = 1; (d?.ns.has(prefix) && d.ns.get(prefix) !== set.uri) || (add.ns.has(prefix) && add.ns.get(prefix) !== set.uri); n++)
        prefix = `${set.prefix}${n}`
      add.ns.set(prefix, set.uri)
    }
    add.props.push({ qname: `${prefix}:${set.local}`, value: set.value })
  }

  for (const [d, add] of additions) {
    const host = d ?? rdf
    const rdfPrefix = prefixOf(host, NS.rdf, true) ?? 'rdf'
    const hostIndent = lineIndent(xml, host.start)
    const firstChild = host.children.find((c) => !c.text)
    const indent = firstChild ? lineIndent(xml, firstChild.start) || `${hostIndent} ` : `${hostIndent} `
    const nsText = [...add.ns].map(([p, u]) => ` xmlns:${p}="${escapeXml(u, true)}"`).join('')
    const body = add.props.map((p) => `\n${indent}${propXml(p.qname, p.value, rdfPrefix, indent)}`).join('')
    if (!d) {
      // rdf:RDF without any rdf:Description: add one before </rdf:RDF>
      const r = rdfPrefix ? `${rdfPrefix}:` : ''
      const inner = add.props.map((p) => `\n${indent} ${propXml(p.qname, p.value, rdfPrefix, `${indent} `)}`).join('')
      const lastChild = [...rdf.children].reverse().find((c) => !c.text)
      splices.push({ at: lastChild ? lastChild.end : rdf.openEnd, end: lastChild ? lastChild.end : rdf.openEnd, text: `\n${indent}<${r}Description ${r}about=""${nsText}>${inner}\n${indent}</${r}Description>` })
      continue
    }
    if (nsText) {
      const at = d.attrs.length ? d.attrs[d.attrs.length - 1].end : d.start + 1 + d.name.length
      splices.push({ at, end: at, text: nsText })
    }
    if (d.selfClosing) splices.push({ at: d.slash, end: d.openEnd, text: `>${body}\n${hostIndent}</${d.name}>` })
    else {
      const last = [...d.children].reverse().find((c) => !c.text)
      const at = last ? last.end : d.openEnd
      splices.push({ at, end: at, text: last ? body : `${body}\n${hostIndent}` })
    }
  }

  // Apply from the end; at the same position a removal/replacement goes before an insertion.
  splices.sort((a, b) => b.at - a.at || b.end - b.at - (a.end - a.at))
  let out = xml
  for (const s of splices) out = out.slice(0, s.at) + s.text + out.slice(s.end)
  return out
}

// ── XMP packets ──────────────────────────────────────────────────────────────

const PACKET_ID = 'W5M0MpCehiHzreSzNTczkc9d'
const NEW_PACKET = `<?xpacket begin="﻿" id="${PACKET_ID}"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>
`
const PACKET_END = '<?xpacket end="w"?>'
const NEW_SIDECAR = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Lumen">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""/>
 </rdf:RDF>
</x:xmpmeta>
`
const PAD = 2048

/** Whitespace padding (lines of 100 bytes) that lets other programs update the packet in place. */
const padding = (n) => (n <= 0 ? '' : `${' '.repeat(99)}\n`.repeat(Math.floor(n / 100)) + ' '.repeat(n % 100))

/** Splits a packet into the XML (with the xpacket header) and its trailing padding + end marker. */
function splitPacket(text) {
  const endPi = text.lastIndexOf('<?xpacket end')
  if (endPi < 0) return { body: text, tail: '', pad: 0 }
  const p = wsBefore(text, endPi)
  return { body: text.slice(0, p), tail: text.slice(endPi), pad: endPi - p }
}

/** The properties to set for a change: { rating?: 0–5, tags?: string[] }. */
function xmpSets({ rating, tags }, { windows = true, iptc = false } = {}) {
  const sets = []
  if (rating !== undefined) {
    const r = cleanRating(rating)
    sets.push({ uri: NS.xmp, local: 'Rating', prefix: 'xmp', value: r ? String(r) : null })
    if (windows) sets.push({ uri: NS.ms, local: 'Rating', prefix: 'MicrosoftPhoto', value: r ? String(starsToPercent(r)) : null })
  }
  if (tags !== undefined) {
    const list = cleanTags(tags)
    sets.push({ uri: NS.dc, local: 'subject', prefix: 'dc', value: list })
    if (windows) sets.push({ uri: NS.ms, local: 'LastKeywordXMP', prefix: 'MicrosoftPhoto', value: list })
    if (windows && iptc) sets.push({ uri: NS.ms, local: 'LastKeywordIPTC', prefix: 'MicrosoftPhoto', value: list })
  }
  return sets
}

/**
 * The new packet bytes for an existing packet (or a new one when `old` is null), or { error }.
 * Keeps the packet the same size when its padding allows (so other programs can still edit in place).
 */
function packetBytes(old, sets) {
  const text = old ? old.toString('utf8') : null
  if (text !== null && !Buffer.from(text, 'utf8').equals(old)) return { error: MSG.xmp } // not UTF-8
  const { body, tail } = text !== null ? splitPacket(text) : { body: NEW_PACKET, tail: PACKET_END }
  const edited = editXmp(body, sets)
  if (edited === null) return { error: MSG.xmp }
  if (text !== null && edited === body) return { bytes: old, same: true }
  const used = Buffer.byteLength(edited) + Buffer.byteLength(tail)
  let pad = tail ? (old ? old.length - used : PAD) : 0
  if (tail && pad < 0) pad = PAD
  const room = MAX_SEGMENT - 2 - XMP_HEADER.length
  if (used + pad > room) pad = Math.max(0, room - used)
  const bytes = Buffer.from(edited + padding(pad) + tail, 'utf8')
  if (bytes.length > room) return { error: MSG.tooBig }
  return { bytes }
}

// ── JPEG structure ───────────────────────────────────────────────────────────

const rd16 = (b, o, le) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
const rd32 = (b, o, le) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
const wr16 = (b, o, v, le) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o))
const wr32 = (b, o, v, le) => (le ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o))

/** Header segments up to the start of scan: { sos, segments: [{ pos, marker, len, kind }] } or null. */
function scanJpeg(d) {
  if (d.length < 4 || d[0] !== 0xff || d[1] !== 0xd8) return null
  let pos = 2
  const segments = []
  while (pos + 1 < d.length) {
    if (d[pos] !== 0xff) return null
    const marker = d[pos + 1]
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (marker === 0xda) return { sos: pos, segments }
    if (marker === 0xd8 || marker === 0xd9 || pos + 4 > d.length) return null
    const len = d.readUInt16BE(pos + 2)
    if (len < 2 || pos + 2 + len > d.length) return null
    let kind = ''
    if (marker === 0xe0) kind = 'app0'
    else if (marker === 0xe1 && len >= 8 && d.toString('latin1', pos + 4, pos + 10) === 'Exif\0\0') kind = 'exif'
    else if (marker === 0xe1 && len >= 2 + XMP_HEADER.length && d.toString('latin1', pos + 4, pos + 4 + XMP_HEADER.length) === XMP_HEADER) kind = 'xmp'
    else if (marker === 0xe2 && len >= 16 && d.toString('latin1', pos + 4, pos + 8) === 'MPF\0') kind = 'mpf'
    else if (marker === 0xed && len >= 16 && d.toString('latin1', pos + 4, pos + 18) === 'Photoshop 3.0\0') kind = 'irb'
    segments.push({ pos, marker, len, kind })
    pos += 2 + len
  }
  return null
}

function readIfd(t, off, le) {
  if (!Number.isInteger(off) || off < 8 || off + 2 > t.length) return null
  const n = rd16(t, off, le)
  if (off + 2 + n * 12 + 4 > t.length) return null
  const entries = []
  for (let i = 0; i < n; i++) {
    const at = off + 2 + i * 12
    entries.push({ tag: rd16(t, at, le), type: rd16(t, at + 2, le), count: rd32(t, at + 4, le), at })
  }
  return { off, entries, next: rd32(t, off + 2 + n * 12, le) }
}

function tiffHead(t) {
  if (t.length < 8) return null
  const order = t.toString('latin1', 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const le = order === 'II'
  if (rd16(t, 2, le) !== 42) return null
  const ifd0 = readIfd(t, rd32(t, 4, le), le)
  return ifd0 ? { le, ifd0 } : null
}

/** IFD0 rating fields: { exifRating, exifPercent, xp }. */
function readExifMarks(t) {
  const head = tiffHead(t)
  if (!head) return {}
  const { le, ifd0 } = head
  const out = {}
  for (const e of ifd0.entries) {
    if ((e.tag === TAG_RATING || e.tag === TAG_RATING_PERCENT) && (e.type === SHORT || e.type === 4)) {
      const v = e.type === SHORT ? rd16(t, e.at + 8, le) : rd32(t, e.at + 8, le)
      out[e.tag === TAG_RATING ? 'exifRating' : 'exifPercent'] = v
    } else if (e.tag === TAG_XP_KEYWORDS) {
      const size = e.count * (TYPE_SIZE[e.type] ?? 1)
      const off = size <= 4 ? e.at + 8 : rd32(t, e.at + 8, le)
      if (off + size <= t.length) out.xp = splitXp(t.toString('utf16le', off, off + (size & ~1)).replace(/\0[\s\S]*$/, ''))
    }
  }
  return out
}

/**
 * Applies a rating/tags change to the EXIF TIFF data, Windows style: existing Rating /
 * RatingPercent / XPKeywords entries are updated (removed when cleared); missing ones aren't added
 * (XMP is what Windows reads first). Every existing byte keeps its offset. Returns a Buffer
 * (possibly the same contents) or null when the EXIF data can't be read.
 */
function editExifTiff(src, { rating, tags }) {
  const head = tiffHead(src)
  if (!head) return null
  const { le } = head
  const t = Buffer.from(src)
  const ifd = readIfd(t, head.ifd0.off, le)
  const find = (tag) => ifd.entries.find((e) => e.tag === tag)
  const remove = new Set()
  let appended = null

  if (rating !== undefined) {
    const r = cleanRating(rating)
    for (const [tag, value] of [
      [TAG_RATING, r],
      [TAG_RATING_PERCENT, starsToPercent(r)],
    ]) {
      const e = find(tag)
      if (!e) continue
      if (!value) {
        remove.add(tag)
        continue
      }
      wr16(t, e.at + 2, SHORT, le)
      wr32(t, e.at + 4, 1, le)
      t.fill(0, e.at + 8, e.at + 12)
      wr16(t, e.at + 8, value, le)
    }
  }

  if (tags !== undefined) {
    const e = find(TAG_XP_KEYWORDS)
    const list = cleanTags(tags)
    if (e && !list.length) remove.add(TAG_XP_KEYWORDS)
    else if (e) {
      const bytes = Buffer.concat([Buffer.from(list.join(';'), 'utf16le'), Buffer.alloc(2)])
      const size = e.count * (TYPE_SIZE[e.type] ?? 1)
      const oldOff = size > 4 ? rd32(t, e.at + 8, le) : -1
      wr16(t, e.at + 2, BYTE, le)
      wr32(t, e.at + 4, bytes.length, le)
      if (bytes.length <= 4) {
        t.fill(0, e.at + 8, e.at + 12)
        bytes.copy(t, e.at + 8)
        if (oldOff >= 8 && oldOff + size <= t.length) t.fill(0, oldOff, oldOff + size)
      } else if (oldOff >= 8 && bytes.length <= size && oldOff + size <= t.length) {
        t.fill(0, oldOff, oldOff + size)
        bytes.copy(t, oldOff)
      } else {
        // Doesn't fit where it was: the new value goes after everything else (nothing moves).
        if (oldOff >= 8 && oldOff + size <= t.length) t.fill(0, oldOff, oldOff + size)
        const at = t.length + (t.length % 2)
        appended = { at, bytes }
        wr32(t, e.at + 8, at, le)
      }
    }
  }

  if (remove.size) {
    const kept = ifd.entries.filter((e) => !remove.has(e.tag)).map((e) => Buffer.from(t.subarray(e.at, e.at + 12)))
    const n0 = ifd.entries.length
    wr16(t, ifd.off, kept.length, le)
    kept.forEach((b, i) => b.copy(t, ifd.off + 2 + i * 12))
    wr32(t, ifd.off + 2 + kept.length * 12, ifd.next, le)
    t.fill(0, ifd.off + 2 + kept.length * 12 + 4, ifd.off + 2 + n0 * 12 + 4)
  }
  if (!appended) return t
  return Buffer.concat([t, Buffer.alloc(appended.at - t.length), appended.bytes])
}

// ── IPTC (Photoshop APP13) ───────────────────────────────────────────────────

/** Photoshop image resources: [{ sig, id, name (raw pascal bytes, padded), data }] or null. */
function parseIrb(body) {
  const out = []
  let p = 0
  while (p + 12 <= body.length) {
    const sig = body.toString('latin1', p, p + 4)
    if (!/^(8BIM|MeSa|PHUT|AgHg|DCSR)$/.test(sig)) return null
    const id = body.readUInt16BE(p + 4)
    const nameLen = body[p + 6]
    const nameSize = (1 + nameLen + 1) & ~1
    const name = body.subarray(p + 6, p + 6 + nameSize)
    const sizeAt = p + 6 + nameSize
    if (sizeAt + 4 > body.length) return null
    const size = body.readUInt32BE(sizeAt)
    if (sizeAt + 4 + size > body.length) return null
    out.push({ sig, id, name, data: body.subarray(sizeAt + 4, sizeAt + 4 + size) })
    p = sizeAt + 4 + size + (size % 2)
  }
  return out
}

function buildIrb(resources) {
  const parts = []
  for (const r of resources) {
    const head = Buffer.alloc(6)
    head.write(r.sig, 0, 'latin1')
    head.writeUInt16BE(r.id, 4)
    const size = Buffer.alloc(4)
    size.writeUInt32BE(r.data.length)
    parts.push(head, r.name, size, r.data)
    if (r.data.length % 2) parts.push(Buffer.alloc(1))
  }
  return Buffer.concat(parts)
}

/** IPTC-IIM datasets: [{ rec, tag, raw, value }] or null. */
function parseIptc(data) {
  const out = []
  let p = 0
  while (p < data.length) {
    if (data[p] === 0) {
      p++ // trailing padding
      continue
    }
    if (data[p] !== 0x1c || p + 5 > data.length) return null
    const rec = data[p + 1]
    const tag = data[p + 2]
    let len = data.readUInt16BE(p + 3)
    let head = 5
    if (len & 0x8000) {
      const n = len & 0x7fff
      if (n > 4 || p + 5 + n > data.length) return null
      len = 0
      for (let i = 0; i < n; i++) len = len * 256 + data[p + 5 + i]
      head += n
    }
    if (p + head + len > data.length) return null
    out.push({ rec, tag, raw: data.subarray(p, p + head + len), value: data.subarray(p + head, p + head + len) })
    p += head + len
  }
  return out
}

const UTF8_MARK = Buffer.from([0x1b, 0x25, 0x47]) // ESC % G
const dataset = (rec, tag, value) => {
  const b = Buffer.alloc(5)
  b[0] = 0x1c
  b[1] = rec
  b[2] = tag
  b.writeUInt16BE(value.length, 3)
  return Buffer.concat([b, value])
}
const isUtf8 = (sets) => !!sets.find((d) => d.rec === 1 && d.tag === 90)?.value.equals(UTF8_MARK)

/** IPTC keywords from an APP13 body (after "Photoshop 3.0\0"), or undefined when there are none. */
function readIptcKeywords(body) {
  const res = parseIrb(body)?.find((r) => r.sig === '8BIM' && r.id === 0x0404)
  const sets = res && parseIptc(res.data)
  if (!sets) return undefined
  const words = sets.filter((d) => d.rec === 2 && d.tag === 25)
  if (!words.length) return undefined
  const utf8 = isUtf8(sets)
  return cleanTags(words.map((d) => d.value.toString(utf8 || isValidUtf8(d.value) ? 'utf8' : 'latin1')))
}
const isValidUtf8 = (b) => Buffer.from(b.toString('utf8'), 'utf8').equals(b)

/**
 * New APP13 body with the IPTC keywords replaced (kept in step with dc:subject, as Windows does),
 * or null when there's no IPTC block to update. The IPTC digest is refreshed when it was current.
 */
function editIptc(body, tags) {
  const resources = parseIrb(body.subarray(14))
  if (!resources) return null
  const idx = resources.findIndex((r) => r.sig === '8BIM' && r.id === 0x0404)
  if (idx < 0) return null
  const old = resources[idx].data
  const sets = parseIptc(old)
  if (!sets) return null
  const list = cleanTags(tags)
  const ascii = list.every((t) => /^[\x20-\x7e]*$/.test(t))
  let utf8 = isUtf8(sets)
  const out = []
  if (!ascii && !sets.some((d) => d.rec === 1 && d.tag === 90)) {
    // Mark the text as UTF-8 (record 1 comes before record 2), as Windows does.
    const firstRec2 = sets.findIndex((d) => d.rec >= 2)
    sets.splice(firstRec2 < 0 ? sets.length : firstRec2, 0, { rec: 1, tag: 90, raw: dataset(1, 90, UTF8_MARK), value: UTF8_MARK })
    utf8 = true
  }
  const encoding = utf8 || ascii || list.some((t) => /[^\u0000-ÿ]/.test(t)) ? 'utf8' : 'latin1'
  const words = list.map((t) => dataset(2, 25, Buffer.from(t, encoding)))
  let placed = false
  let lastRec2 = -1
  for (const d of sets) {
    if (d.rec === 2 && d.tag === 25) {
      if (!placed) out.push(...words)
      placed = true
      continue
    }
    out.push(d.raw)
    if (d.rec === 2) lastRec2 = out.length
  }
  if (!placed && words.length) {
    if (lastRec2 < 0) out.push(dataset(2, 0, Buffer.from([0, 4])), ...words)
    else out.splice(lastRec2, 0, ...words)
  }
  const data = Buffer.concat(out)
  if (data.equals(old)) return null
  const next = resources.map((r) => ({ ...r }))
  next[idx].data = data
  const digest = next.find((r) => r.sig === '8BIM' && r.id === 0x0425)
  if (digest && digest.data.length === 16 && digest.data.equals(crypto.createHash('md5').update(old).digest()))
    digest.data = crypto.createHash('md5').update(data).digest()
  return Buffer.concat([body.subarray(0, 14), buildIrb(next)])
}

// ── MPF (multi-picture: depth maps, Ultra HDR gain maps…) ─────────────────────

/** Adds `delta` to the offsets of the extra pictures listed in an APP2 MPF segment at `seg`. */
function shiftMpf(buf, seg, delta) {
  const base = seg + 8
  const end = seg + 2 + buf.readUInt16BE(seg + 2)
  const order = buf.toString('latin1', base, base + 2)
  if (order !== 'II' && order !== 'MM') return false
  const le = order === 'II'
  const ifdAt = base + rd32(buf, base + 4, le)
  if (ifdAt + 2 > end) return false
  const n = rd16(buf, ifdAt, le)
  if (ifdAt + 2 + n * 12 > end) return false
  for (let i = 0; i < n; i++) {
    const at = ifdAt + 2 + i * 12
    if (rd16(buf, at, le) !== 0xb002) continue
    const count = rd32(buf, at + 4, le)
    const list = base + rd32(buf, at + 8, le)
    if (count % 16 || list + count > end) return false
    for (let e = list; e < list + count; e += 16) {
      const off = rd32(buf, e + 8, le)
      if (off) wr32(buf, e + 8, off + delta, le)
    }
    return true
  }
  return true
}

// ── reading & writing JPEGs ──────────────────────────────────────────────────

const segmentBody = (d, s) => d.subarray(s.pos + 4, s.pos + 2 + s.len)

/** Everything rating/keyword related in a JPEG buffer, as combine() inputs; null if not a JPEG. */
function readJpegSources(d) {
  const scan = scanJpeg(d)
  if (!scan) return null
  const src = {}
  const exif = scan.segments.find((s) => s.kind === 'exif')
  if (exif) Object.assign(src, readExifMarks(segmentBody(d, exif).subarray(6)))
  const x = scan.segments.find((s) => s.kind === 'xmp')
  if (x) Object.assign(src, readXmp(segmentBody(d, x).subarray(XMP_HEADER.length).toString('utf8')) ?? {})
  const irb = scan.segments.find((s) => s.kind === 'irb')
  if (irb) {
    const kw = readIptcKeywords(segmentBody(d, irb).subarray(14))
    if (kw) src.iptc = kw
  }
  return src
}

/** { rating?, tags? } stored in a JPEG buffer (null when it isn't one). */
function readJpeg(d) {
  const src = readJpegSources(d)
  return src && combine(src)
}

/**
 * The new file contents with the rating and/or tags set: { data, changed } or { error }.
 * `rating`: 0–5 (0 clears), `tags`: string[] (the full list; [] clears); leave either undefined
 * to keep it. Pure: works on a buffer, never on disk.
 */
function applyJpeg(data, { rating, tags } = {}) {
  if (!Buffer.isBuffer(data)) return { error: MSG.invalid }
  const scan = scanJpeg(data)
  if (!scan) return { error: MSG.invalid }
  if (rating === undefined && tags === undefined) return { data, changed: false }
  const list = tags === undefined ? undefined : cleanTags(tags)
  const changes = [] // { pos, end, bytes } in original positions (end === pos: an insertion)

  const seg = (marker, body) => {
    const head = Buffer.from([0xff, marker, 0, 0])
    head.writeUInt16BE(body.length + 2, 2)
    return Buffer.concat([head, body])
  }

  const exif = scan.segments.find((s) => s.kind === 'exif')
  if (exif) {
    const body = segmentBody(data, exif)
    const tiff = editExifTiff(body.subarray(6), { rating, tags: list })
    if (tiff && !tiff.equals(body.subarray(6))) {
      if (tiff.length + 6 > MAX_SEGMENT) {
        // No room to grow: drop the old keywords instead (Windows reads XMP first anyway).
        const fallback = editExifTiff(body.subarray(6), { rating, tags: [] })
        if (fallback) changes.push({ pos: exif.pos, end: exif.pos + 2 + exif.len, bytes: seg(0xe1, Buffer.concat([body.subarray(0, 6), fallback])) })
      } else changes.push({ pos: exif.pos, end: exif.pos + 2 + exif.len, bytes: seg(0xe1, Buffer.concat([body.subarray(0, 6), tiff])) })
    }
  }

  let iptcUpdated = false
  const irbs = scan.segments.filter((s) => s.kind === 'irb')
  if (list !== undefined && irbs.length === 1) {
    const body = editIptc(segmentBody(data, irbs[0]), list)
    if (body && body.length <= MAX_SEGMENT) {
      changes.push({ pos: irbs[0].pos, end: irbs[0].pos + 2 + irbs[0].len, bytes: seg(0xed, body) })
      iptcUpdated = true
    }
  }
  const hasIptc = iptcUpdated || (irbs.length > 0 && readIptcKeywords(segmentBody(data, irbs[0]).subarray(14)) !== undefined)

  const x = scan.segments.find((s) => s.kind === 'xmp')
  const sets = xmpSets({ rating, tags: list }, { windows: true, iptc: hasIptc })
  const packet = packetBytes(x ? segmentBody(data, x).subarray(XMP_HEADER.length) : null, sets)
  if (packet.error) return packet
  if (!packet.same) {
    const bytes = seg(0xe1, Buffer.concat([Buffer.from(XMP_HEADER, 'latin1'), packet.bytes]))
    if (x) changes.push({ pos: x.pos, end: x.pos + 2 + x.len, bytes })
    else {
      // A new packet goes right after EXIF (where Windows puts it), else after JFIF, else after SOI.
      const after = exif ?? scan.segments.find((s) => s.kind === 'app0' && s.pos === 2)
      const at = after ? after.pos + 2 + after.len : 2
      changes.push({ pos: at, end: at, bytes })
    }
  }
  if (!changes.length) return { data, changed: false }

  changes.sort((a, b) => a.pos - b.pos || a.end - a.pos - (b.end - b.pos)) // insertions first
  const parts = []
  let from = 0
  for (const c of changes) {
    parts.push(data.subarray(from, c.pos), c.bytes)
    from = c.end
  }
  parts.push(data.subarray(from))
  const out = Buffer.concat(parts)
  const growth = out.length - data.length

  // Pictures appended after the main one (MPF) are found by offsets that start at the MPF header:
  // whatever grew after that header moved them.
  for (const s of scan.segments.filter((g) => g.kind === 'mpf')) {
    const after = changes.filter((c) => c.pos > s.pos).reduce((n, c) => n + c.bytes.length - (c.end - c.pos), 0)
    const before = changes.filter((c) => c.pos <= s.pos && c.end <= s.pos).reduce((n, c) => n + c.bytes.length - (c.end - c.pos), 0)
    if (after && !shiftMpf(out, s.pos + before, after)) return { error: MSG.layout }
  }

  // Safety net: the compressed picture and everything after it must be byte-identical.
  const check = scanJpeg(out)
  if (!check || check.sos !== scan.sos + growth || !out.subarray(check.sos).equals(data.subarray(scan.sos))) return { error: MSG.layout }
  return { data: out, changed: true }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES'])

/** Runs fn, retrying 15 × 150 ms while another program has the file open. */
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!BUSY.has(err.code) || attempt >= 15) throw err
      await sleep(150)
    }
  }
}

/** Reads the start of a JPEG up to its picture data (enough for every header segment). */
async function readHeader(file) {
  const fh = await fsp.open(file, 'r')
  try {
    let size = 256 * 1024
    for (;;) {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      const data = buf.subarray(0, bytesRead)
      if (bytesRead < size || scanJpeg(data)) return data
      size *= 4
    }
  } finally {
    await fh.close()
  }
}

/** { rating?, tags? } stored in a JPEG file (null when unreadable / not a JPEG). */
async function readJpegFile(file) {
  try {
    return readJpeg(await readHeader(file))
  } catch {
    return null
  }
}

/** Writes bytes to "<file>.lumen-tags.tmp" and swaps it in (retrying while another program has it open). */
async function replaceFile(file, bytes) {
  const temp = `${file}.lumen-tags.tmp`
  const fh = await fsp.open(temp, 'w')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } catch (err) {
    await fh.close().catch(() => {})
    await fsp.unlink(temp).catch(() => {})
    throw err
  }
  await fh.close()
  await replaceWithTemp(temp, file)
}

/**
 * Saves the rating and/or tags inside a JPEG (lossless, atomic, keeps the file's modified date
 * and "date created"). Never rejects. Resolves { ok: true, changed, size, mtime } — the file's new
 * size and its (unchanged) modified time in ms — or { error, busy? }.
 */
async function writeJpeg(file, { rating, tags } = {}) {
  if (!/\.(jpe?g|jpe|jfif)$/i.test(file)) return { error: MSG.notJpeg }
  try {
    const st = await fsp.stat(file)
    const out = applyJpeg(await withRetry(() => fsp.readFile(file)), { rating, tags })
    if (out.error) return { error: out.error }
    if (!out.changed) return { ok: true, changed: false, size: st.size, mtime: Math.round(st.mtimeMs) }
    await replaceFile(file, out.data)
    // A new rating shouldn't make an old photo look new (and Lumen's caches key on this date).
    await withRetry(() => fsp.utimes(file, st.atimeMs / 1000, st.mtimeMs / 1000)).catch(() => {})
    const after = await fsp.stat(file)
    return { ok: true, changed: true, size: after.size, mtime: Math.round(after.mtimeMs) }
  } catch (err) {
    return BUSY.has(err?.code) ? { error: MSG.busy, busy: true } : { error: String(err?.message ?? err) }
  }
}

// ── exifr (library scans) ────────────────────────────────────────────────────

/**
 * Options to merge into the library's exifr.parse() call: the XMP packet as raw text (parsed here,
 * so xmp:Rating and MicrosoftPhoto:Rating don't collide) and only the IPTC keywords.
 */
const EXIFR_OPTIONS = Object.freeze({ xmp: { parse: false }, iptc: ['Keywords'] })

/** exifr reads IPTC text as Latin-1; UTF-8 keywords (what Windows and phones write) are re-read. */
function utf8FromLatin1(s) {
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s
  const b = Buffer.from(s, 'latin1')
  return isValidUtf8(b) ? b.toString('utf8') : s
}

/** { rating?, tags? } from exifr output parsed with EXIFR_OPTIONS (null when there's nothing). */
function fromExifr(d) {
  if (!d || typeof d !== 'object') return null
  const x = typeof d.xmp === 'string' ? readXmp(d.xmp) ?? {} : {}
  const out = combine({
    ...x,
    exifRating: d.Rating,
    exifPercent: d.RatingPercent,
    xp: typeof d.XPKeywords === 'string' ? splitXp(d.XPKeywords) : undefined,
    iptc: asList(d.Keywords)?.map(utf8FromLatin1),
  })
  return out.rating === undefined && out.tags === undefined ? null : out
}

// ── videos (read only): what Explorer writes into MP4/MOV ────────────────────
// moov/udta/Xtra holds entries [size u32][name length u32][name][value count u32] then values
// [size u32][type u16][data]: WM/SharedUserRating = VT_UI8 percent, WM/Category = BSTR keywords.

/** Children of an ISO-BMFF box body: [{ type, start, end }] (start = first content byte). */
function boxes(b, from = 0, to = b.length) {
  const out = []
  let p = from
  while (p + 8 <= to) {
    let size = b.readUInt32BE(p)
    let head = 8
    if (size === 1 && p + 16 <= to) {
      size = Number(b.readBigUInt64BE(p + 8))
      head = 16
    } else if (size === 0) size = to - p
    if (size < head || p + size > to) break
    out.push({ type: b.toString('latin1', p + 4, p + 8), start: p + head, end: p + size })
    p += size
  }
  return out
}

/**
 * { rating?, tags? } that Windows saved in a video, from the body of its moov box (what
 * library.cjs readMp4() already reads into `moov`); null when there's none.
 */
function fromMoov(moov) {
  if (!Buffer.isBuffer(moov)) return null
  const udta = boxes(moov).find((x) => x.type === 'udta')
  const xtra = udta && boxes(moov, udta.start, udta.end).find((x) => x.type === 'Xtra')
  if (!xtra) return null
  const out = {}
  let p = xtra.start
  while (p + 12 <= xtra.end) {
    const size = moov.readUInt32BE(p)
    const nameLen = moov.readUInt32BE(p + 4)
    if (size < 12 || p + size > xtra.end || 8 + nameLen + 4 > size) break
    const name = moov.toString('latin1', p + 8, p + 8 + nameLen)
    let q = p + 8 + nameLen
    const count = moov.readUInt32BE(q)
    q += 4
    const values = []
    for (let i = 0; i < count && q + 6 <= p + size; i++) {
      const vSize = moov.readUInt32BE(q)
      const type = moov.readUInt16BE(q + 4)
      if (vSize < 6 || q + vSize > p + size) break
      const data = moov.subarray(q + 6, q + vSize)
      if (type === 0x13 && data.length >= 8) values.push(Number(data.readBigUInt64LE(0)))
      else if (type === 0x08) values.push(data.toString('utf16le').replace(/\0[\s\S]*$/, ''))
      q += vSize
    }
    if (name === 'WM/SharedUserRating' && typeof values[0] === 'number') out.rating = percentToStars(values[0])
    if (name === 'WM/Category') out.tags = cleanTags(values.filter((v) => typeof v === 'string'))
    p += size
  }
  return out.rating === undefined && out.tags === undefined ? null : out
}

// ── XMP sidecars (other formats; Lightroom: "IMG_1.xmp" next to "IMG_1.HEIC") ────

/** Possible sidecars of a file: "<name>.xmp" (Lightroom) and "<name>.<ext>.xmp" (darktable, digiKam). */
const sidecarPaths = (file) => {
  const ext = path.extname(file)
  return [`${file.slice(0, file.length - ext.length)}.xmp`, `${file}.xmp`]
}

/** The sidecar that exists for this file (null when none). Use it to move sidecars with their file. */
async function findSidecar(file) {
  for (const p of sidecarPaths(file).reverse()) {
    try {
      if ((await fsp.stat(p)).isFile()) return p
    } catch {}
  }
  return null
}

/** { rating?, tags? } from the file's sidecar, or null when there is none. */
async function readSidecar(file) {
  const p = await findSidecar(file)
  if (!p) return null
  try {
    const x = readXmp(await fsp.readFile(p, 'utf8'))
    if (!x) return null
    const out = combine(x)
    return out.rating === undefined && out.tags === undefined ? null : out
  } catch {
    return null
  }
}

/**
 * Writes the rating and/or tags into the file's XMP sidecar, keeping everything else in it
 * (e.g. Lightroom's develop settings). A new sidecar is "<name>.xmp", or "<name>.<ext>.xmp" when
 * another file in the folder shares the name (a Live Photo's video, RAW + JPEG). Never rejects:
 * resolves { ok: true, path } or { error }.
 */
async function writeSidecar(file, { rating, tags } = {}) {
  try {
    let target = await findSidecar(file)
    let text = NEW_SIDECAR
    if (target) text = await fsp.readFile(target, 'utf8')
    else if (!cleanRating(rating) && !cleanTags(tags).length) return { ok: true, path: null } // nothing to keep
    else {
      const [lightroom, full] = sidecarPaths(file)
      const base = path.basename(lightroom, '.xmp').toLowerCase()
      const own = path.basename(file).toLowerCase()
      const names = await fsp.readdir(path.dirname(file)).catch(() => [])
      const shared = names.some((n) => n.toLowerCase() !== own && !n.toLowerCase().endsWith('.xmp') && path.basename(n, path.extname(n)).toLowerCase() === base)
      target = shared ? full : lightroom
    }
    const { body, tail } = splitPacket(text)
    const edited = editXmp(body, xmpSets({ rating, tags: tags === undefined ? undefined : cleanTags(tags) }, { windows: false }))
    if (edited === null) return { error: "The photo's XMP sidecar couldn't be read, so it was left alone." }
    if (edited === body && text !== NEW_SIDECAR) return { ok: true, path: target }
    const temp = `${target}.lumen.tmp`
    await fsp.writeFile(temp, edited + tail, 'utf8')
    await fsp.rename(temp, target).catch(async (err) => {
      await fsp.unlink(temp).catch(() => {})
      throw err
    })
    return { ok: true, path: target }
  } catch (err) {
    return { error: BUSY.has(err?.code) ? MSG.busy : String(err?.message ?? err) }
  }
}

const JPEG_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif'])
/** True when ratings/tags can be stored inside this file (JPEG). */
const canEmbed = (fileOrExt) => {
  const s = String(fileOrExt ?? '').toLowerCase()
  return JPEG_EXT.has(s.slice(s.lastIndexOf('.') + 1))
}

module.exports = {
  // values
  cleanRating,
  cleanTag,
  cleanTags,
  sameTags,
  starsToPercent,
  percentToStars,
  combine,
  // JPEG
  canEmbed,
  applyJpeg,
  readJpeg,
  readJpegSources,
  readJpegFile,
  writeJpeg,
  // scans
  EXIFR_OPTIONS,
  fromExifr,
  fromMoov,
  // sidecars
  sidecarPaths,
  findSidecar,
  readSidecar,
  writeSidecar,
  // XMP text (exported for tests)
  readXmp,
  editXmp,
  parseXml,
  MSG,
}
