import type { MediaItem } from '../types'
import { baseName } from './format'

const ASCII = /^[\x00-\x7f]*$/

/** Lower case without accents, so "thane" finds "Thāne". (Plain ASCII has no accents to strip.) */
export const fold = (s: string) => (ASCII.test(s) ? s.toLowerCase() : s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase())

const monthLong = new Intl.DateTimeFormat(undefined, { month: 'long' })
const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' })

export const MONTH_WORDS = new Set<string>()
for (let m = 0; m < 12; m++) {
  const d = new Date(2000, m, 15)
  MONTH_WORDS.add(fold(monthLong.format(d)))
  MONTH_WORDS.add(fold(monthShort.format(d)).replace('.', ''))
}
export const TYPE_WORDS = new Set(['photo', 'photos', 'picture', 'pictures', 'image', 'images', 'video', 'videos'])

const textCache = new WeakMap<MediaItem, string>()
/** "March Mar 2023" per month: formatting dates is the slow part of indexing 10,000s of items. */
const monthTexts = new Map<number, string>()
const monthText = (d: Date) => {
  const key = d.getFullYear() * 12 + d.getMonth()
  let text = monthTexts.get(key)
  if (text === undefined) monthTexts.set(key, (text = `${monthLong.format(d)} ${monthShort.format(d)} ${d.getFullYear()}`))
  return text
}

/** Everything a search can match about an item besides people, places and what's in it. */
export function itemText(item: MediaItem) {
  let text = textCache.get(item)
  if (text === undefined) {
    const d = new Date(item.date)
    text = fold(
      [
        item.name,
        baseName(item.dir),
        monthText(d),
        item.meta?.make,
        item.meta?.model,
        item.type === 'video' ? 'video videos' : 'photo photos picture pictures image images',
        item.ext,
      ]
        .filter(Boolean)
        .join(' '),
    )
    textCache.set(item, text)
  }
  return text
}

export const searchTokens = (query: string) => fold(query).split(/\s+/).filter(Boolean).slice(0, 8)

/** Bit i is set when token i appears in the item's text, its people's names or its place. */
export function tokenMask(item: MediaItem, tokens: string[], names?: string, place?: string) {
  const text = itemText(item)
  let mask = 0
  tokens.forEach((t, i) => {
    if (text.includes(t) || (names !== undefined && names.includes(t)) || (place !== undefined && place.includes(t))) mask |= 1 << i
  })
  return mask
}
