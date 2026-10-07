import type { MediaItem } from '../types'

const STILLS = new Set(['heic', 'heif', 'jpg', 'jpeg'])
const CLIPS = new Set(['mov', 'mp4'])
const MAX_SECONDS = 6
const MAX_BYTES = 12 * 1024 * 1024

/**
 * Live Photos: an iPhone saves the still (IMG_1234.HEIC) and a ~3 s clip (IMG_1234.MOV) side by
 * side. They're shown as one item: the photo, with its motion one click away.
 * Returns photo id → its clip, and the set of clip ids to hide from the grid.
 */
export function pairLivePhotos(items: MediaItem[]) {
  const stills = new Map<string, MediaItem>()
  for (const it of items) {
    if (it.type === 'image' && STILLS.has(it.ext)) stills.set(`${it.dir}|${stem(it.name)}`.toLowerCase(), it)
  }
  const live = new Map<string, MediaItem>()
  const hidden = new Set<string>()
  for (const it of items) {
    if (it.type !== 'video' || !CLIPS.has(it.ext)) continue
    const short = it.duration ? it.duration <= MAX_SECONDS : it.size <= MAX_BYTES
    if (!short) continue
    const still = stills.get(`${it.dir}|${stem(it.name)}`.toLowerCase())
    if (!still || live.has(still.id)) continue
    live.set(still.id, it)
    hidden.add(it.id)
  }
  return { live, hidden }
}

const stem = (name: string) => name.replace(/\.[^.]+$/, '')
