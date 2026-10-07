// Dates in file names (ported from DupeLens' DateTools). Phones, WhatsApp and screenshot tools
// put the capture date in the name; when a file has no EXIF date this is the next best thing.
const path = require('node:path')

const PATTERNS = [
  // IMG-20221216-WA0037 (WhatsApp): day only
  { re: /(?:IMG|VID|AUD|PTT|STK|DOC)-(\d{8})-WA\d+/i, time: false },
  // Screenshot_2020-04-23-13-18-24, "2022-12-16 14.30.05"
  { re: /(?<!\d)(\d{4})-(\d{2})-(\d{2})[ _-](\d{2})[-.](\d{2})[-.](\d{2})/, time: true },
  // 20210608_131304, IMG_20220415_132047, PXL_20230101_101010123
  { re: /(?<!\d)(\d{8})[_-](\d{6})/, time: true },
  // 2022-12-16, 20221216
  { re: /(?<!\d)(\d{4})-?(\d{2})-?(\d{2})(?!\d)/, time: false },
]

function makeDate(digits) {
  const y = +digits.slice(0, 4)
  const mo = +digits.slice(4, 6)
  const d = +digits.slice(6, 8)
  const h = digits.length >= 10 ? +digits.slice(8, 10) : 0
  const mi = digits.length >= 12 ? +digits.slice(10, 12) : 0
  const s = digits.length >= 14 ? +digits.slice(12, 14) : 0
  const date = new Date(y, mo - 1, d, h, mi, s)
  // exact parse: the calendar must agree (no 31 February), plausible range
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return null
  if (y < 1990 || date.getTime() > Date.now() + 2 * 86_400_000) return null
  return date.getTime()
}

/** { date (ms, local), hasTime } from a file name, or null. */
function fromFileName(name) {
  const stem = path.basename(name, path.extname(name))
  for (const { re, time } of PATTERNS) {
    const m = stem.match(re)
    if (!m) continue
    const date = makeDate(m.slice(1).join(''))
    if (date !== null) return { date, hasTime: time }
  }
  return null
}

/** A trustworthy capture date: EXIF/video metadata, else the date in the name (midnight). Never the file date. */
function knownDate(item) {
  if (Number.isFinite(item.taken)) return item.taken
  const f = fromFileName(item.name)
  return f ? f.date : null
}

module.exports = { fromFileName, knownDate }
