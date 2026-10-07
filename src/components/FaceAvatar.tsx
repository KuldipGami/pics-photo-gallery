import { UserRound } from 'lucide-react'
import type { CSSProperties } from 'react'
import { thumbUrl } from '../api'
import type { FaceBox, MediaItem } from '../types'

interface Props {
  item: MediaItem | undefined
  box: FaceBox
  /** Photo aspect ratio (width / height). */
  ar: number
  size: number
  className?: string
}

/**
 * A square crop around one face, cut out of the photo's existing thumbnail with CSS
 * (background-size/position), so no extra image files are needed for avatars.
 */
export function FaceAvatar({ item, box, ar, size, className = '' }: Props) {
  const style: CSSProperties = { width: size, height: size }
  if (item) {
    const [x, y, w, h] = box
    const cx = x + w / 2
    const cy = y + h / 2
    // Work in units of the photo's height; leave some room around the face.
    const side = Math.min(Math.max(w * ar, h) * 1.7, ar, 1)
    const cw = side / ar
    const ch = side
    const left = Math.min(Math.max(cx - cw / 2, 0), 1 - cw)
    const top = Math.min(Math.max(cy - ch / 2, 0), 1 - ch)
    style.backgroundImage = `url("${thumbUrl(item)}")`
    style.backgroundSize = `${100 / cw}% ${100 / ch}%`
    style.backgroundPosition = `${cw >= 1 ? 0 : (left / (1 - cw)) * 100}% ${ch >= 1 ? 0 : (top / (1 - ch)) * 100}%`
  }
  return (
    <div className={`face-avatar ${className}`} style={style} aria-hidden="true">
      {!item && <UserRound size={size * 0.45} />}
    </div>
  )
}
