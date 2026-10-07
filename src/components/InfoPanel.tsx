import { Aperture, Calendar, CalendarClock, ExternalLink, FileImage, Film, Folder, MapPin, RotateCcw, RotateCw, UserRoundPen, UserRoundSearch, UserX, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api'
import { baseName, formatBytes, formatDuration, formatExposure, formatLongDate, formatTime } from '../lib/format'
import { fileNameDate } from '../lib/insights'
import type { FaceBox, MediaItem, Place } from '../types'
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
  /** Where it was taken (from GPS, if any). */
  place?: Place
  onOpenPlace(id: string): void
  onOpenPerson(id: string): void
  /** Open the person picker for this face (Who's this? / Change person). */
  onAssignFace(face: PhotoFace): void
  onRemoveFace(face: PhotoFace): void
  onHighlight(box: FaceBox | null): void
  onClose(): void
  onToast(text: string): void
}

const JPEG = new Set(['jpg', 'jpeg', 'jpe', 'jfif'])
const p2 = (n: number) => String(n).padStart(2, '0')
const editText = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
/** DupeLens' accepted date formats: yyyy-MM-dd[ HH:mm[:ss]], yyyy:MM:dd HH:mm:ss, dd-MM-yyyy[ HH:mm]. */
function parseDate(text: string): number | null {
  const t = text.trim()
  let m = t.match(/^(\d{4})[-:](\d{1,2})[-:](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/)
  let y, mo, d, h, mi, s
  if (m) [, y, mo, d, h = '0', mi = '0', s = '0'] = m
  else if ((m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?: (\d{1,2}):(\d{2}))?$/))) [, d, mo, y, h = '0', mi = '0'] = m
  else {
    const any = Date.parse(t)
    return Number.isFinite(any) ? any : null
  }
  const date = new Date(+y, +mo - 1, +d, +h, +mi, +(s ?? 0))
  return date.getMonth() === +mo - 1 && date.getDate() === +d ? date.getTime() : null
}

export function InfoPanel({ item, dims, faces, place, onOpenPlace, onOpenPerson, onAssignFace, onRemoveFace, onHighlight, onClose, onToast }: Props) {
  const m = item.meta ?? {}
  const jpeg = item.type === 'image' && JPEG.has(item.ext)
  const [dateText, setDateText] = useState(() => editText(item.taken ?? item.date))
  const [dateError, setDateError] = useState('')
  useEffect(() => {
    setDateText(editText(item.taken ?? item.date))
    setDateError('')
  }, [item.id, item.taken])
  const nameDate = fileNameDate(item.name)
  const saveDate = async () => {
    const ms = parseDate(dateText)
    if (ms === null) return setDateError('Use a date like 2021-06-08 13:11:51')
    if (new Date(ms).getFullYear() < 1900 || ms > Date.now() + 86_400_000) return setDateError('That date looks wrong.')
    setDateError('')
    const res = await api.setDateTaken(item.id, ms)
    if (res.error) setDateError(res.error)
    else onToast(`Saved ${new Date(ms).toLocaleString()} inside ${item.name}. Undo it from History if needed.`)
  }
  const turn = async (q: number) => {
    const res = await api.rotateLossless([item.id], q)
    onToast(res.done ? `Turned ${item.name}. Undo it from History if needed.` : `Couldn't turn ${item.name}: ${res.errors[0] ?? ''}`)
  }
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
        <div className="info-row">
          <MapPin size={18} />
          <div>
            {place ? (
              <button className="info-link" onClick={() => onOpenPlace(place.id)} title={`All photos from ${place.name}`}>
                {place.name}
              </button>
            ) : (
              <div className="info-primary">Location</div>
            )}
            {place && <div className="info-secondary">{[place.admin, place.country].filter(Boolean).join(', ')}</div>}
            <button
              className="info-secondary info-map"
              onClick={() => api.openUrl(`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=15/${m.lat}/${m.lon}`)}
              title="Open in OpenStreetMap (in your browser)"
            >
              {m.lat.toFixed(5)}, {m.lon.toFixed(5)} <ExternalLink size={12} />
            </button>
          </div>
        </div>
      )}

      {item.type === 'image' && (
        <div className="info-row">
          <RotateCw size={18} />
          <div>
            <div className="info-primary">Turn</div>
            {jpeg ? (
              <>
                <div className="info-edit">
                  <button className="btn ghost" onClick={() => turn(3)}>
                    <RotateCcw size={15} /> Turn left
                  </button>
                  <button className="btn ghost" onClick={() => turn(1)}>
                    <RotateCw size={15} /> Turn right
                  </button>
                </div>
                <div className="info-secondary">Lossless: only the orientation tag changes, the picture is never re-saved.</div>
              </>
            ) : (
              <div className="info-secondary">Only JPEG photos can be turned without re-saving them — use Edit to save a turned copy.</div>
            )}
          </div>
        </div>
      )}

      {item.type === 'image' && (
        <div className="info-row">
          <CalendarClock size={18} />
          <div>
            <div className="info-primary">Change date taken</div>
            {jpeg ? (
              <>
                <div className="info-edit">
                  <input
                    value={dateText}
                    placeholder="yyyy-MM-dd HH:mm:ss"
                    onChange={(e) => setDateText(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') saveDate()
                    }}
                  />
                  <button className="btn ghost" onClick={saveDate}>
                    Save
                  </button>
                </div>
                {dateError && <div className="info-error">{dateError}</div>}
                {nameDate && (
                  <button
                    className="link"
                    onClick={() => setDateText(editText(nameDate.hasTime ? nameDate.date : nameDate.date + 12 * 3_600_000))}
                  >
                    Use the date in the file name
                  </button>
                )}
                <div className="info-secondary">Saved inside the photo without re-saving the image, so there's no quality loss. Undo any time from History.</div>
              </>
            ) : (
              <div className="info-secondary">Only JPEG photos can be changed without re-saving them.</div>
            )}
          </div>
        </div>
      )}
    </aside>
  )
}
