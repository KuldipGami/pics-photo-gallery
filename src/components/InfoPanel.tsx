import { Aperture, Calendar, ExternalLink, FileImage, Film, Folder, MapPin, UserRoundPen, UserRoundSearch, UserX, Users, X } from 'lucide-react'
import { api } from '../api'
import { baseName, formatBytes, formatDuration, formatExposure, formatLongDate, formatTime } from '../lib/format'
import type { FaceBox, MediaItem } from '../types'
import { FaceAvatar } from './FaceAvatar'
import { PopoverMenu } from './PopoverMenu'

/** A face in the current photo — recognised (personId) or not (null). */
export interface PhotoFace {
  faceId: string
  personId: string | null
  name: string
  box: FaceBox
  ar: number
}

interface Props {
  item: MediaItem
  dims: { w: number; h: number } | null
  faces: PhotoFace[]
  onOpenPerson(id: string): void
  /** Open the person picker for this face (Who's this? / Change person). */
  onAssignFace(face: PhotoFace): void
  onRemoveFace(face: PhotoFace): void
  onHighlight(box: FaceBox | null): void
  onClose(): void
}

export function InfoPanel({ item, dims, faces, onOpenPerson, onAssignFace, onRemoveFace, onHighlight, onClose }: Props) {
  const m = item.meta ?? {}
  const camera = m.model ? (m.make && !m.model.startsWith(m.make) ? `${m.make} ${m.model}` : m.model) : m.make
  const exposure = [
    m.f && `ƒ/${+m.f.toFixed(1)}`,
    m.exposure && formatExposure(m.exposure),
    m.focal && `${+m.focal.toFixed(1)}mm`,
    m.iso && `ISO ${m.iso}`,
  ].filter(Boolean)
  const fileDetails = [
    dims && `${dims.w} × ${dims.h}`,
    dims && item.type === 'image' && `${((dims.w * dims.h) / 1e6).toFixed(1)} MP`,
    item.type === 'video' && formatDuration(item.duration),
    formatBytes(item.size),
  ].filter(Boolean)

  return (
    <aside className="info-panel">
      <div className="info-head">
        <h3>Details</h3>
        <button className="icon-btn" onClick={onClose} title="Close (I)">
          <X size={18} />
        </button>
      </div>

      <div className="info-row">
        <Calendar size={18} />
        <div>
          <div className="info-primary">{formatLongDate(item.date)}</div>
          <div className="info-secondary">{formatTime(item.date)}</div>
        </div>
      </div>

      <div className="info-row">
        {item.type === 'video' ? <Film size={18} /> : <FileImage size={18} />}
        <div>
          <div className="info-primary break">{item.name}</div>
          <div className="info-secondary">{fileDetails.join(' · ')}</div>
        </div>
      </div>

      {faces.length > 0 && (
        <div className="info-row">
          <Users size={18} />
          <div className="info-people">
            {faces.map((f) => {
              const label = f.personId ? f.name || 'Unnamed person' : "Who's this?"
              const items = f.personId
                ? [
                    { label: `Go to ${f.name || 'this person'}`, icon: <Users size={15} />, onClick: () => onOpenPerson(f.personId!) },
                    { label: 'Change person…', icon: <UserRoundPen size={15} />, onClick: () => onAssignFace(f) },
                    { label: `Not ${f.name || 'this person'}`, icon: <UserX size={15} />, danger: true, onClick: () => onRemoveFace(f) },
                  ]
                : [{ label: "Who's this?…", icon: <UserRoundSearch size={15} />, onClick: () => onAssignFace(f) }]
              return (
                <PopoverMenu
                  key={f.faceId}
                  align="left"
                  dark
                  items={items}
                  trigger={(open, toggle) => (
                    <button
                      className={`person-chip${f.personId ? '' : ' unknown'}${open ? ' open' : ''}`}
                      onClick={toggle}
                      onMouseEnter={() => onHighlight(f.box)}
                      onMouseLeave={() => onHighlight(null)}
                    >
                      <FaceAvatar item={item} box={f.box} ar={f.ar} size={28} />
                      <span className={f.personId && f.name ? '' : 'unnamed'}>{label}</span>
                    </button>
                  )}
                />
              )
            })}
          </div>
        </div>
      )}

      {camera && (
        <div className="info-row">
          <Aperture size={18} />
          <div>
            <div className="info-primary">{camera}</div>
            {exposure.length > 0 && <div className="info-secondary">{exposure.join(' · ')}</div>}
            {m.lens && <div className="info-secondary">{m.lens}</div>}
          </div>
        </div>
      )}

      <button className="info-row clickable" onClick={() => api.reveal(item.id)} title="Show in folder">
        <Folder size={18} />
        <div>
          <div className="info-primary">{baseName(item.dir)}</div>
          <div className="info-secondary break">{item.dir}</div>
        </div>
      </button>

      {m.lat !== undefined && m.lon !== undefined && (
        <button
          className="info-row clickable"
          onClick={() =>
            api.openUrl(`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=15/${m.lat}/${m.lon}`)
          }
          title="Open map"
        >
          <MapPin size={18} />
          <div>
            <div className="info-primary">Location</div>
            <div className="info-secondary">
              {m.lat.toFixed(5)}, {m.lon.toFixed(5)}
            </div>
          </div>
          <ExternalLink size={14} className="info-trailing" />
        </button>
      )}
    </aside>
  )
}
