import { useState, type ReactNode } from 'react'
import { thumbUrl } from '../api'
import type { MediaItem } from '../types'

/** A thumbnail that shows `fallback` (an icon) when there's no item or its preview can't be made. */
export function CoverImage({ item, fallback, lazy }: { item: MediaItem | undefined; fallback: ReactNode; lazy?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (!item || failed === item.id) return <>{fallback}</>
  return <img src={thumbUrl(item)} alt="" draggable={false} loading={lazy ? 'lazy' : undefined} onError={() => setFailed(item.id)} />
}
