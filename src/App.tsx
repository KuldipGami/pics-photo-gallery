import {
  Album as AlbumIcon,
  ArrowDownUp,
  ArrowLeft,
  Ellipsis,
  Eye,
  EyeOff,
  Film,
  FolderOpen,
  FolderPlus,
  Heart,
  ImageMinus,
  ImagePlus,
  ImageUp,
  Images,
  LayoutGrid,
  LoaderCircle,
  Map as MapIcon,
  MapPin,
  Merge,
  Plus,
  Search,
  Sparkles,
  Trash,
  UserRoundPen,
  UserX,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { AlbumNameDialog, AlbumPicker, AlbumsView, AlbumTitle } from './components/AlbumsView'
import { DuplicatesView } from './components/DuplicatesView'
import { FoldersView, type FolderInfo } from './components/FoldersView'
import { FaceAvatar } from './components/FaceAvatar'
import { Gallery } from './components/Gallery'
import type { PhotoFace } from './components/InfoPanel'
import { Logo } from './components/Logo'
import { ConfirmDialog, DropOverlay, EmptyState, Toasts, type ConfirmOptions } from './components/Overlays'
import { PeopleView } from './components/PeopleView'
import { PersonName, PersonPicker, SuggestionsReview } from './components/PersonDialogs'
import { FacesGrid, PossibleMatches } from './components/PersonTools'
import { PlacesView } from './components/PlacesView'
import { PopoverMenu } from './components/PopoverMenu'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { Viewer } from './components/Viewer'
import { useEvent, useLibrary, useSmartSearch, useToasts } from './hooks'
import { baseName, formatCount, formatRange, summarize } from './lib/format'
import { fold, MONTH_WORDS, searchTokens, tokenMask, TYPE_WORDS } from './lib/search'
import type { FaceBox, FaceRef, MediaItem, PairSuggestion, Person, PersonMatch, TypeFilter, View } from './types'

interface PickerOptions {
  title: string
  description?: string
  exclude?: Set<string>
  allowNew?: boolean
  onPick(target: Person | { name: string }): void
}

const ZOOM_STEPS = [80, 100, 124, 150, 180, 220, 270, 330]
const BIN = api.env.platform === 'win32' ? 'Recycle Bin' : 'Trash'
const GRID_VIEWS: View['kind'][] = ['photos', 'videos', 'favorites', 'recent', 'folder', 'person', 'place', 'album']

const TITLES: Record<View['kind'], string> = {
  photos: 'Photos',
  videos: 'Videos',
  favorites: 'Favorites',
  recent: 'Recently added',
  folders: 'Folders',
  folder: '',
  people: 'People',
  person: '',
  places: 'Places',
  place: '',
  albums: 'Albums',
  album: '',
  duplicates: 'Duplicates',
  settings: 'Settings',
}

export default function App() {
  const {
    items,
    settings,
    setSettings,
    status,
    thumbProgress,
    version,
    people,
    peopleProgress,
    albums,
    places,
    dupes,
    dupesProgress,
    smartProgress,
  } = useLibrary()
  const [view, setView] = useState<View>({ kind: 'photos' })
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sortAsc, setSortAsc] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [viewer, setViewer] = useState<{ ids: string[]; index: number } | null>(null)
  const [focus, setFocus] = useState<{ id: string } | null>(null)
  const [thumbSize, setThumbSize] = useState(180)
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [showHiddenPeople, setShowHiddenPeople] = useState(false)
  const [showSmallPeople, setShowSmallPeople] = useState(false)
  const [peopleSelection, setPeopleSelection] = useState<Set<string>>(() => new Set())
  const [personTab, setPersonTab] = useState<'photos' | 'faces'>('photos')
  const [faceSelection, setFaceSelection] = useState<Set<string>>(() => new Set())
  const faceAnchor = useRef<number | null>(null)
  const [picker, setPicker] = useState<PickerOptions | null>(null)
  const [suggestions, setSuggestions] = useState<PairSuggestion[]>([])
  /** Suggestions frozen when the review opens (the live list changes as you merge). */
  const [reviewing, setReviewing] = useState<PairSuggestion[] | null>(null)
  const [matches, setMatches] = useState<PersonMatch[]>([])
  /** "Add to album…" for these items. */
  const [albumPicker, setAlbumPicker] = useState<string[] | null>(null)
  const [newAlbum, setNewAlbum] = useState(false)
  const [placeCountry, setPlaceCountry] = useState<string | null>(null)
  const { toasts, push: toast } = useToasts()
  const searchRef = useRef<HTMLInputElement>(null)
  const selectAnchor = useRef<number | null>(null)
  const internalDrag = useRef(false)
  /** Items dragged from the grid (they can be dropped on an album in the sidebar). */
  const draggingIds = useRef<string[]>([])

  // ---------- settings sync ----------
  const sizeLoaded = useRef(false)
  useEffect(() => {
    if (settings && !sizeLoaded.current) {
      sizeLoaded.current = true
      setThumbSize(settings.thumbSize)
    }
  }, [settings])
  useEffect(() => {
    if (!sizeLoaded.current) return
    const t = setTimeout(() => api.setSettings({ thumbSize }), 400)
    return () => clearTimeout(t)
  }, [thumbSize])

  useEffect(() => {
    if (settings) document.documentElement.style.setProperty('--accent', settings.accent)
  }, [settings?.accent])
  useEffect(() => {
    document.documentElement.classList.toggle('mica', api.env.mica)
    document.documentElement.dataset.platform = api.env.platform
  }, [])

  // ---------- derived data ----------
  const byId = useMemo(() => new Map(items.map((it) => [it.id, it])), [items])
  const favorites = useMemo(() => new Set(settings?.favorites ?? []), [settings?.favorites])
  const tokens = useMemo(() => searchTokens(query), [query])
  const dateField = view.kind === 'recent' ? 'added' : 'date'
  const isGrid = GRID_VIEWS.includes(view.kind)
  const favDep = view.kind === 'favorites' ? favorites : null

  // ---------- albums & places ----------
  const albumById = useMemo(() => new Map(albums.map((a) => [a.id, a])), [albums])
  const currentAlbum = view.kind === 'album' ? albumById.get(view.id) : undefined
  const placeById = useMemo(() => new Map(places.places.map((p) => [p.id, p])), [places.places])
  const currentPlace = view.kind === 'place' ? placeById.get(view.id) : undefined
  /** Folded "town state country" of each photo with a position, for search. */
  const placeTextByItem = useMemo(() => {
    const text = new Map<string, string>()
    for (const p of places.places) text.set(p.id, fold(`${p.name} ${p.admin} ${p.country}`))
    const map = new Map<string, string>()
    for (const [itemId, pid] of Object.entries(places.byItem)) {
      const t = text.get(pid)
      if (t) map.set(itemId, t)
    }
    return map
  }, [places])
  const placeDep = view.kind === 'place' ? places.byItem : null

  // ---------- people ----------
  const peopleById = useMemo(() => new Map(people.people.map((p) => [p.id, p])), [people.people])
  /** Lower-cased names of the (named) people in each photo, for search. */
  const namesByItem = useMemo(() => {
    const map = new Map<string, string>()
    for (const [itemId, entry] of Object.entries(people.byItem)) {
      const names = entry.faces.map(([, pid]) => (pid ? peopleById.get(pid)?.name : '')).filter(Boolean)
      if (names.length) map.set(itemId, fold(names.join(' ')))
    }
    return map
  }, [people.byItem, peopleById])
  /** Every recognised face, per person, least similar first (for the Faces tab and reviews). */
  const facesByPerson = useMemo(() => {
    const map = new Map<string, FaceRef[]>()
    for (const [item, entry] of Object.entries(people.byItem)) {
      for (const [faceId, pid, x, y, w, h, dist] of entry.faces) {
        if (!pid) continue
        let list = map.get(pid)
        if (!list) map.set(pid, (list = []))
        list.push({ faceId, personId: pid, item, box: [x, y, w, h], ar: entry.ar, dist })
      }
    }
    for (const list of map.values()) list.sort((a, b) => b.dist - a.dist)
    return map
  }, [people.byItem])
  const isSmall = (p: Person) => !p.name && p.count < 3
  const shownPeople = useMemo(() => {
    const q = query.trim().toLowerCase()
    return people.people.filter(
      (p) =>
        (showHiddenPeople || !p.hidden) &&
        (showSmallPeople || q || !isSmall(p)) &&
        (!q || p.name.toLowerCase().includes(q)),
    )
  }, [people.people, showHiddenPeople, showSmallPeople, query])
  const smallPeopleCount = useMemo(() => people.people.filter((p) => !p.hidden && isSmall(p)).length, [people.people])
  const currentPerson = view.kind === 'person' ? peopleById.get(view.id) : undefined
  const personDep = view.kind === 'person' ? people.byItem : null
  const personFaces = currentPerson ? (facesByPerson.get(currentPerson.id) ?? []) : []

  /** Faces in a photo for the viewer's details panel, left to right. */
  const facesIn = (itemId: string): PhotoFace[] => {
    const entry = people.byItem[itemId]
    if (!entry) return []
    return entry.faces
      .map(([faceId, pid, x, y, w, h]) => ({
        faceId,
        personId: pid && peopleById.has(pid) ? pid : null,
        name: (pid && peopleById.get(pid)?.name) || '',
        box: [x, y, w, h] as FaceBox,
        ar: entry.ar,
      }))
      .sort((a, b) => a.box[0] - b.box[0])
  }

  // Suggestions are computed in the main process; refresh them whenever People changes.
  useEffect(() => {
    if (view.kind !== 'people') return
    let live = true
    api.peopleSuggestions().then((s) => live && setSuggestions(s))
    return () => {
      live = false
    }
  }, [view.kind, people])
  useEffect(() => {
    if (!currentPerson) return setMatches([])
    let live = true
    api.personMatches(currentPerson.id).then((m) => live && setMatches(m))
    return () => {
      live = false
    }
  }, [currentPerson?.id, people])

  /** The current view's items before searching. */
  const baseList = useMemo(() => {
    let list = items
    if (view.kind === 'videos') list = list.filter((it) => it.type === 'video')
    else if (view.kind === 'favorites') list = list.filter((it) => favorites.has(it.id))
    else if (view.kind === 'folder') list = list.filter((it) => it.dir === view.dir)
    else if (view.kind === 'person') {
      list = list.filter((it) => people.byItem[it.id]?.faces.some(([, pid]) => pid === view.id))
    } else if (view.kind === 'place') list = list.filter((it) => places.byItem[it.id] === view.id)
    else if (view.kind === 'album') {
      const members = new Set(currentAlbum?.items ?? [])
      list = list.filter((it) => members.has(it.id))
    }
    if (typeFilter !== 'all' && view.kind !== 'videos') list = list.filter((it) => it.type === typeFilter)
    return list
    // `favDep`/`personDep`/`placeDep` instead of the full objects: toggling a heart or renaming
    // someone shouldn't refilter views that don't depend on them.
  }, [items, view, typeFilter, favDep, personDep, placeDep, currentAlbum])

  // ---------- search ----------
  // Every word is matched against what Lumen knows about an item (name, folder, date, camera,
  // people, place). Known names, places and dates must match; other words left over are looked up
  // by what's in the photo (smart search): "goa beach 2023" = taken in Goa, in 2023, showing a beach.
  const knownWords = useMemo(() => {
    const known = new Set<string>([...MONTH_WORDS, ...TYPE_WORDS])
    const add = (text: string | undefined) => {
      if (text) for (const w of fold(text).split(/[^\p{L}\p{N}]+/u)) if (w.length > 1) known.add(w)
    }
    for (const p of people.people) add(p.name)
    for (const p of places.places) {
      add(p.name)
      add(p.admin)
      add(p.country)
    }
    for (const it of items) {
      add(it.meta?.make)
      add(it.meta?.model)
    }
    return [...known]
  }, [people.people, places.places, items])
  const smartOn = settings?.smartSearch !== false && smartProgress.available && smartProgress.indexed > 0
  const search = useMemo(() => {
    if (!tokens.length || !isGrid) return null
    const known = new Set(knownWords)
    const typingLast = !/\s$/.test(query)
    const isKnown = (t: string, i: number) =>
      /^\d+$/.test(t) ||
      known.has(t) ||
      (typingLast && i === tokens.length - 1 && t.length >= 2 && knownWords.some((w) => w.startsWith(t)))
    const full = (1 << tokens.length) - 1
    let strict = 0 // names, places, dates…: an item must match these itself
    tokens.forEach((t, i) => {
      if (isKnown(t, i)) strict |= 1 << i
    })
    const masks = new Map<string, number>()
    const phrases = new Map<number, number>() // mask -> how many items need it
    for (const it of baseList) {
      const mask = tokenMask(it, tokens, namesByItem.get(it.id), placeTextByItem.get(it.id))
      masks.set(it.id, mask)
      if (mask === full || (mask & strict) !== strict) continue
      phrases.set(mask, (phrases.get(mask) ?? 0) + 1)
    }
    const phraseOf = (mask: number) => tokens.filter((_, i) => !(mask & (1 << i))).join(' ')
    const lookups = [...phrases.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([mask]) => phraseOf(mask))
    return { masks, full, strict, lookups, phraseOf }
  }, [tokens, query, isGrid, baseList, namesByItem, placeTextByItem, knownWords])
  const smart = useSmartSearch(smartOn && search ? search.lookups : [])

  const visible = useMemo(() => {
    let list = baseList
    if (search) {
      const { masks, full, strict, phraseOf } = search
      list = list.filter((it) => {
        const mask = masks.get(it.id) ?? 0
        if (mask === full) return true
        return (mask & strict) === strict && !!smart.matches?.get(phraseOf(mask))?.has(it.id)
      })
    }
    return [...list].sort((a, b) => (sortAsc ? a[dateField] - b[dateField] : b[dateField] - a[dateField]))
  }, [baseList, search, smart.matches, sortAsc, dateField])
  const smartHits = useMemo(() => {
    if (!search || !smart.matches) return 0
    let n = 0
    for (const it of visible) if ((search.masks.get(it.id) ?? 0) !== search.full) n++
    return n
  }, [visible, search, smart.matches])

  const folders = useMemo(() => {
    const map = new Map<string, FolderInfo>()
    for (const it of [...items].sort((a, b) => b.date - a.date)) {
      let f = map.get(it.dir)
      if (!f) {
        f = { dir: it.dir, name: baseName(it.dir), count: 0, latest: it.date, covers: [] }
        map.set(it.dir, f)
      }
      f.count++
      if (f.covers.length < 3) f.covers.push(it)
    }
    return [...map.values()].sort((a, b) => b.latest - a.latest)
  }, [items])

  const visibleFolders = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? folders.filter((f) => f.dir.toLowerCase().includes(q)) : folders
  }, [folders, query])

  const counts = useMemo(() => {
    let videos = 0
    let favs = 0
    for (const it of items) {
      if (it.type === 'video') videos++
      if (favorites.has(it.id)) favs++
    }
    const visiblePeople = people.people.filter((p) => !p.hidden).length
    return {
      all: items.length,
      videos,
      favorites: favs,
      folders: folders.length,
      people: visiblePeople,
      places: places.places.length,
    }
  }, [items, favorites, folders, people.people, places.places])

  const shownPlaces = useMemo(() => {
    const q = fold(query.trim())
    return q ? places.places.filter((p) => fold(`${p.name} ${p.admin} ${p.country}`).includes(q)) : places.places
  }, [places.places, query])
  const shownAlbums = useMemo(() => {
    const q = fold(query.trim())
    return q ? albums.filter((a) => fold(a.name).includes(q)) : albums
  }, [albums, query])
  // Reclaimable space shown next to "Duplicates" (exact copies only: nothing is lost by removing them).
  const duplicateBytes = useMemo(() => {
    let bytes = 0
    for (const g of dupes.exact) {
      const live = g.ids.filter((id) => byId.has(id))
      if (live.length > 1) bytes += (g.size ?? 0) * (live.length - 1)
    }
    return bytes
  }, [dupes.exact, byId])

  const viewerItems = useMemo(
    () => (viewer ? viewer.ids.map((id) => byId.get(id)).filter((it): it is MediaItem => !!it) : []),
    [viewer?.ids, byId],
  )
  const viewerIndex = viewer ? Math.min(viewer.index, viewerItems.length - 1) : -1

  useEffect(() => {
    if (viewer && viewerItems.length === 0) setViewer(null)
  }, [viewer, viewerItems.length])

  const viewKey = view.kind === 'folder' ? view.dir : 'id' in view ? view.id : ''
  const resetKey = `${view.kind}|${viewKey}|${typeFilter}|${query}|${sortAsc}`

  // A person can disappear (merged away, or their last photo removed): fall back to People.
  // Same for a deleted album, or a place whose last photo is gone.
  useEffect(() => {
    if (view.kind === 'person' && !peopleById.has(view.id)) setView({ kind: 'people' })
    if (view.kind === 'album' && !albumById.has(view.id)) setView({ kind: 'albums' })
    if (view.kind === 'place' && places.places.length && !placeById.has(view.id)) setView({ kind: 'places' })
  }, [view, peopleById, albumById, placeById, places.places.length])
  useEffect(() => {
    setSelection(new Set())
    selectAnchor.current = null
    setFaceSelection(new Set())
    faceAnchor.current = null
  }, [resetKey, personTab])
  useEffect(() => setPersonTab('photos'), [viewKey])
  useEffect(() => {
    if (view.kind !== 'people') setPeopleSelection(new Set())
  }, [view.kind])
  // Drop selected people that no longer exist (merged away).
  useEffect(() => {
    setPeopleSelection((prev) => {
      const next = new Set([...prev].filter((id) => peopleById.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [peopleById])

  useEffect(() => {
    api.setViewerMode(!!viewer)
  }, [!!viewer])

  // ---------- actions ----------
  const navigate = (next: View) => {
    setView(next)
    if (['settings', 'folders', 'people', 'person', 'places', 'albums', 'duplicates'].includes(next.kind)) setTypeFilter('all')
  }

  // ---------- albums ----------
  const addToAlbum = async (albumId: string, ids: string[]) => {
    const album = albumById.get(albumId)
    const added = await api.addToAlbum(albumId, ids)
    setSelection(new Set())
    const name = album?.name ?? 'the album'
    toast(added ? `Added ${plural(added, 'item')} to ${name}` : `Already in ${name}`)
  }
  const createAlbumWith = async (name: string, ids: string[]) => {
    const id = await api.createAlbum(name, ids)
    setSelection(new Set())
    toast(ids.length ? `Created “${name || 'Untitled album'}” with ${plural(ids.length, 'item')}` : `Created “${name}”`)
    return id
  }
  const deleteAlbum = (albumId: string) => {
    const album = albumById.get(albumId)
    if (!album) return
    setConfirm({
      title: `Delete “${album.name}”?`,
      message: 'Only the album is deleted — the photos and videos in it stay in your library and on disk.',
      confirmLabel: 'Delete album',
      danger: true,
      onConfirm: () => {
        api.deleteAlbum(albumId)
        setView({ kind: 'albums' })
        toast('Album deleted')
      },
    })
  }

  const openPerson = (id: string) => {
    setViewer(null)
    setQuery('')
    navigate({ kind: 'person', id })
  }

  const nameOf = (p: Person | undefined) => p?.name || 'this person'
  const plural = (n: number, word: string) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`

  const mergePerson = (from: Person, into: Person) => {
    api.mergePeople([from.id], into.id)
    setView({ kind: 'person', id: into.id })
    toast(into.name ? `Merged into ${into.name}` : 'Merged')
  }

  /** Merge several groups; the named (or biggest) one survives. */
  const mergeGroups = (ids: string[]) => {
    const list = ids.map((id) => peopleById.get(id)).filter((p): p is Person => !!p)
    if (list.length < 2) return
    const into = [...list].sort((a, b) => Number(!!b.name) - Number(!!a.name) || b.count - a.count)[0]
    const names = [...new Set(list.map((p) => p.name).filter(Boolean))]
    setConfirm({
      title: `Merge ${list.length} groups?`,
      message:
        names.length > 1
          ? `They have different names (${names.join(', ')}). They'll become one person called “${into.name}”.`
          : `They'll become one person${into.name ? ` called “${into.name}”` : ''}. You can still move individual photos out later.`,
      confirmLabel: 'Merge',
      onConfirm: () => {
        api.mergePeople(
          list.filter((p) => p.id !== into.id).map((p) => p.id),
          into.id,
        )
        setPeopleSelection(new Set())
        toast(`Merged ${list.length} groups${into.name ? ` into ${into.name}` : ''}`)
      },
    })
  }

  /** Open the person picker to move faces somewhere else ("Move to…", "Who's this?"). */
  const moveFaces = (faceIds: string[], from: Person | undefined, title = 'Move to…') => {
    if (!faceIds.length) return
    setPicker({
      title,
      description: from
        ? `${plural(faceIds.length, 'face')} will move out of ${nameOf(from)}. Pick who ${faceIds.length === 1 ? 'it is' : 'they are'}, or create a new person.`
        : 'Pick who this is, or create a new person.',
      exclude: from ? new Set([from.id]) : undefined,
      allowNew: true,
      onPick: async (target) => {
        setPicker(null)
        const id = await api.assignFaces(faceIds, 'id' in target ? target.id : { name: target.name })
        setSelection(new Set())
        setFaceSelection(new Set())
        if (!id) return toast("Couldn't move those faces")
        const to = 'id' in target ? target.name || 'that person' : target.name || 'a new person'
        toast(`Moved ${plural(faceIds.length, 'face')} to ${to}`)
      },
    })
  }

  const rejectFaces = (faceIds: string[], from: Person | undefined) => {
    if (!faceIds.length) return
    api.rejectFaces(faceIds)
    setSelection(new Set())
    setFaceSelection(new Set())
    toast(`Removed ${plural(faceIds.length, 'face')} from ${nameOf(from)}`)
  }

  /** The current person's faces inside the given photos. */
  const personFaceIds = (person: Person, itemIds: Iterable<string>) => {
    const out: string[] = []
    for (const itemId of itemIds) {
      for (const [faceId, pid] of people.byItem[itemId]?.faces ?? []) if (pid === person.id) out.push(faceId)
    }
    return out
  }

  const removePersonGroup = (person: Person) =>
    setConfirm({
      title: `Remove ${person.name ? `“${person.name}”` : 'this group'}?`,
      message:
        'The faces are ungrouped and won’t be grouped automatically again. Your photos are not touched. Use Hide instead if you just don’t want to see this person in People.',
      confirmLabel: 'Remove person',
      danger: true,
      onConfirm: () => {
        api.removePerson(person.id)
        setView({ kind: 'people' })
        toast('Person removed')
      },
    })

  const renamePerson = (person: Person, name: string) => {
    const twin = name && people.people.find((p) => p.id !== person.id && p.name.toLowerCase() === name.toLowerCase())
    if (twin) {
      setConfirm({
        title: `Combine with “${twin.name}”?`,
        message: `There's already someone called ${twin.name}. If this is the same person, their photos will be combined.`,
        confirmLabel: 'Combine',
        onConfirm: () => mergePerson(person, twin),
      })
      return
    }
    api.renamePerson(person.id, name)
  }

  const toggleFace = (face: FaceRef, index: number, e: { shiftKey: boolean }) => {
    const anchor = faceAnchor.current
    setFaceSelection((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && anchor !== null) {
        for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i++) next.add(personFaces[i].faceId)
      } else if (next.has(face.faceId)) next.delete(face.faceId)
      else next.add(face.faceId)
      return next
    })
    faceAnchor.current = index
  }

  const togglePersonSelect = (id: string) =>
    setPeopleSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const openViewer = (index: number) => setViewer({ ids: visible.map((it) => it.id), index })

  const closeViewer = () => {
    const current = viewerItems[viewerIndex]
    if (current) setFocus({ id: current.id })
    setViewer(null)
  }

  const zoomGrid = (dir: 1 | -1) => {
    setThumbSize((size) => {
      const i = ZOOM_STEPS.reduce((best, s, idx) => (Math.abs(s - size) < Math.abs(ZOOM_STEPS[best] - size) ? idx : best), 0)
      return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))]
    })
  }

  const toggleFavorite = (ids: string[], value?: boolean) => {
    const v = value ?? !ids.every((id) => favorites.has(id))
    const idSet = new Set(ids)
    setSettings((s) =>
      s && {
        ...s,
        favorites: v ? [...new Set([...s.favorites, ...ids])] : s.favorites.filter((id) => !idSet.has(id)),
      },
    )
    api.setFavorite(ids, v)
    return v
  }

  const requestDelete = (ids: string[], label?: string) => {
    if (!ids.length) return
    const first = byId.get(ids[0])
    setConfirm({
      title: ids.length > 1 ? `Move ${formatCount(ids.length)} items to the ${BIN}?` : `Move to the ${BIN}?`,
      message: label
        ? `${label[0].toUpperCase()}${label.slice(1)} will be moved to the ${BIN}. You can restore ${ids.length > 1 ? 'them' : 'it'} from there.`
        : ids.length > 1
          ? `You can restore them from the ${BIN} later.`
          : `“${first?.name ?? 'This item'}” will be moved to the ${BIN}. You can restore it from there.`,
      confirmLabel: `Move to ${BIN}`,
      danger: true,
      onConfirm: async () => {
        const res = await api.trash(ids)
        setSelection((prev) => {
          const next = new Set(prev)
          for (const id of ids) next.delete(id)
          return next
        })
        toast(
          res.failed
            ? `Moved ${res.removed}, couldn't move ${res.failed}`
            : `Moved ${res.removed} item${res.removed === 1 ? '' : 's'} to the ${BIN}`,
        )
      },
    })
  }

  const addFolders = async (paths?: string[]) => {
    const before = settings?.folders.length ?? 0
    const next = await api.addFolders(paths)
    if (next.folders.length > before) {
      toast(`Added ${baseName(next.folders[next.folders.length - 1])} — scanning…`)
    } else if (paths) {
      toast('Drop a folder (not individual files) to add it')
    }
  }

  const selectIndex = (index: number, mode: 'toggle' | 'range') => {
    const anchor = selectAnchor.current
    setSelection((prev) => {
      const next = new Set(prev)
      if (mode === 'range' && anchor !== null) {
        for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i++) next.add(visible[i].id)
      } else {
        const id = visible[index].id
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    })
    selectAnchor.current = index
  }

  const selectRange = (start: number, end: number, value: boolean) => {
    setSelection((prev) => {
      const next = new Set(prev)
      for (let i = start; i < end; i++) {
        if (value) next.add(visible[i].id)
        else next.delete(visible[i].id)
      }
      return next
    })
  }

  // Native context-menu actions that need the renderer.
  const onMenuAction = useEvent(({ action, id, ids }: { action: 'open' | 'delete' | 'album'; id: string; ids: string[] }) => {
    if (action === 'open') {
      const index = visible.findIndex((it) => it.id === id)
      if (index >= 0) openViewer(index)
    } else if (action === 'album') {
      setAlbumPicker(ids)
    } else {
      requestDelete(ids)
    }
  })
  useEffect(() => api.onMenuAction(onMenuAction), [onMenuAction])

  // ---------- keyboard ----------
  const onKey = useEvent((e: KeyboardEvent) => {
    if (viewer || confirm || picker || reviewing || albumPicker || newAlbum) return
    const key = e.key.toLowerCase()
    const typing = !!(e.target as HTMLElement)?.closest?.('input, textarea')
    if ((e.ctrlKey || e.metaKey) && key === 'f') {
      e.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (e.key === 'F5') {
      e.preventDefault()
      api.rescan()
      return
    }
    if (typing) return
    if (e.key === '/') {
      e.preventDefault()
      searchRef.current?.focus()
    } else if ((e.ctrlKey || e.metaKey) && key === 'a' && currentPerson && personTab === 'faces') {
      e.preventDefault()
      setFaceSelection(new Set(personFaces.map((f) => f.faceId)))
    } else if ((e.ctrlKey || e.metaKey) && key === 'a' && isGrid) {
      e.preventDefault()
      setSelection(new Set(visible.map((it) => it.id)))
    } else if (e.key === 'Escape') {
      if (selection.size) setSelection(new Set())
      else if (faceSelection.size) setFaceSelection(new Set())
      else if (peopleSelection.size) setPeopleSelection(new Set())
      else if (query) setQuery('')
    } else if (e.key === 'Delete' && selection.size) {
      requestDelete([...selection])
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      zoomGrid(1)
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault()
      zoomGrid(-1)
    }
  })
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onKey])

  // Thumbnails dragged out of the app start a native drag; don't treat those as folder drops.
  useEffect(() => {
    const start = () => (internalDrag.current = true)
    const reset = () => {
      internalDrag.current = false
      draggingIds.current = []
    }
    window.addEventListener('dragstart', start)
    window.addEventListener('mousemove', reset)
    return () => {
      window.removeEventListener('dragstart', start)
      window.removeEventListener('mousemove', reset)
    }
  }, [])

  if (!settings) return <div className="boot" />

  // ---------- header ----------
  const allSelectedFav = selection.size > 0 && [...selection].every((id) => favorites.has(id))
  const title = view.kind === 'folder' ? baseName(view.dir) : currentPlace ? currentPlace.name : TITLES[view.kind]
  let subtitle = ''
  if (isGrid) {
    subtitle = summarize(visible)
    const range = formatRange(visible, dateField)
    if (range) subtitle += ` · ${range}`
    if (currentPlace) subtitle = `${[currentPlace.admin, currentPlace.country].filter(Boolean).join(', ')} · ${subtitle}`
    if (search && smart.pending) subtitle += ' · Looking inside photos…'
    else if (smartHits) subtitle += ` · ${formatCount(smartHits)} found by what's in them`
  } else if (view.kind === 'places') {
    subtitle = places.places.length
      ? `${formatCount(places.places.length)} places · from photo locations, worked out on this computer`
      : 'From photo locations, worked out on this computer'
  } else if (view.kind === 'albums') {
    subtitle = `${formatCount(albums.length)} album${albums.length === 1 ? '' : 's'}`
  } else if (view.kind === 'duplicates') {
    subtitle = 'Exact copies and look-alikes in your library'
  } else if (view.kind === 'folders') {
    subtitle = `${formatCount(visibleFolders.length)} folder${visibleFolders.length === 1 ? '' : 's'}`
  } else if (view.kind === 'settings') {
    subtitle = 'Manage your library and preferences'
  } else if (view.kind === 'people') {
    subtitle = shownPeople.length
      ? `${formatCount(shownPeople.length)} ${shownPeople.length === 1 ? 'person' : 'people'} · grouped by face, on this computer`
      : 'Grouped by face, on this computer'
  }

  const personMenu = currentPerson && (
    <PopoverMenu
      items={[
        {
          label: 'Choose cover photo',
          icon: <ImageUp size={15} />,
          onClick: () => {
            setPersonTab('faces')
            toast('Select one face, then click “Use as cover”')
          },
        },
        {
          label: currentPerson.hidden ? 'Show in People' : 'Hide from People',
          icon: currentPerson.hidden ? <Eye size={15} /> : <EyeOff size={15} />,
          onClick: () => {
            api.hidePerson(currentPerson.id, !currentPerson.hidden)
            toast(currentPerson.hidden ? 'Shown in People again' : 'Hidden from People')
          },
        },
        { label: 'Remove person…', icon: <UserX size={15} />, danger: true, onClick: () => removePersonGroup(currentPerson) },
      ]}
      trigger={(open, toggle) => (
        <button className={`icon-btn${open ? ' on' : ''}`} onClick={toggle} title="More">
          <Ellipsis size={18} />
        </button>
      )}
    />
  )

  const clearAll = () => {
    setSelection(new Set())
    setFaceSelection(new Set())
    setPeopleSelection(new Set())
  }
  const selectionBar = (count: number, children: ReactNode) => (
    <div className="content-header selection-mode">
      <button className="icon-btn" onClick={clearAll} title="Clear selection (Esc)">
        <X size={20} />
      </button>
      <div className="selection-count">{formatCount(count)} selected</div>
      <div className="spacer" />
      {children}
    </div>
  )

  let header: ReactNode
  if (selection.size > 0) {
    const selectedFaces = currentPerson ? personFaceIds(currentPerson, selection) : []
    header = selectionBar(
      selection.size,
      <>
        <button className="btn ghost" onClick={() => setSelection(new Set(visible.map((it) => it.id)))}>
          Select all
        </button>
        {currentPerson && (
          <>
            <button className="btn ghost" onClick={() => moveFaces(selectedFaces, currentPerson)} title="These photos are someone else">
              <UserRoundPen size={15} /> Move to…
            </button>
            <button className="btn ghost" onClick={() => rejectFaces(selectedFaces, currentPerson)} title="These photos aren't this person">
              <UserX size={15} /> Not {nameOf(currentPerson)}
            </button>
            {selection.size === 1 && selectedFaces.length > 0 && (
              <button
                className="btn ghost"
                onClick={() => {
                  api.setPersonCover(currentPerson.id, selectedFaces[0])
                  setSelection(new Set())
                  toast('Cover photo updated')
                }}
              >
                <ImageUp size={15} /> Use as cover
              </button>
            )}
          </>
        )}
        {currentAlbum && (
          <>
            {selection.size === 1 && (
              <button
                className="btn ghost"
                onClick={() => {
                  api.setAlbumCover(currentAlbum.id, [...selection][0])
                  setSelection(new Set())
                  toast('Album cover updated')
                }}
              >
                <ImageUp size={15} /> Use as cover
              </button>
            )}
            <button
              className="btn ghost"
              title="Take them out of this album (the files are kept)"
              onClick={() => {
                const ids = [...selection]
                api.removeFromAlbum(currentAlbum.id, ids)
                setSelection(new Set())
                toast(`Removed ${plural(ids.length, 'item')} from ${currentAlbum.name}`)
              }}
            >
              <ImageMinus size={15} /> Remove from album
            </button>
          </>
        )}
        <button className="btn ghost" onClick={() => setAlbumPicker([...selection])}>
          <ImagePlus size={15} /> Add to album
        </button>
        <button className="btn ghost" onClick={() => toggleFavorite([...selection])}>
          <Heart size={15} fill={allSelectedFav ? 'currentColor' : 'none'} />
          {allSelectedFav ? 'Unfavorite' : 'Favorite'}
        </button>
        <button className="btn danger" onClick={() => requestDelete([...selection])}>
          <Trash size={15} /> Delete
        </button>
      </>,
    )
  } else if (faceSelection.size > 0 && currentPerson) {
    const ids = [...faceSelection]
    header = selectionBar(
      ids.length,
      <>
        <button className="btn ghost" onClick={() => setFaceSelection(new Set(personFaces.map((f) => f.faceId)))}>
          Select all
        </button>
        <button className="btn ghost" onClick={() => moveFaces(ids, currentPerson)}>
          <UserRoundPen size={15} /> Move to…
        </button>
        {ids.length === 1 && (
          <button
            className="btn ghost"
            onClick={() => {
              api.setPersonCover(currentPerson.id, ids[0])
              setFaceSelection(new Set())
              toast('Cover photo updated')
            }}
          >
            <ImageUp size={15} /> Use as cover
          </button>
        )}
        <button className="btn danger" onClick={() => rejectFaces(ids, currentPerson)}>
          <UserX size={15} /> Not {nameOf(currentPerson)}
        </button>
      </>,
    )
  } else if (peopleSelection.size > 0 && view.kind === 'people') {
    const ids = [...peopleSelection]
    const allHidden = ids.every((id) => peopleById.get(id)?.hidden)
    header = selectionBar(
      ids.length,
      <>
        <button className="btn ghost" onClick={() => setPeopleSelection(new Set(shownPeople.map((p) => p.id)))}>
          Select all
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            api.hidePeople(ids, !allHidden)
            setPeopleSelection(new Set())
            toast(allHidden ? `Showing ${plural(ids.length, 'person')} again` : `Hid ${plural(ids.length, 'person')}`)
          }}
        >
          {allHidden ? <Eye size={15} /> : <EyeOff size={15} />} {allHidden ? 'Show' : 'Hide'}
        </button>
        <button className="btn primary" disabled={ids.length < 2} onClick={() => mergeGroups(ids)} title="These groups are the same person">
          <Merge size={15} /> Merge {ids.length > 1 ? formatCount(ids.length) : ''}
        </button>
      </>,
    )
  } else {
    header = (
      <div className="content-header">
        {view.kind === 'folder' && (
          <button className="icon-btn back" onClick={() => setView({ kind: 'folders' })} title="Back to folders">
            <ArrowLeft size={20} />
          </button>
        )}
        {view.kind === 'album' && (
          <button className="icon-btn back" onClick={() => setView({ kind: 'albums' })} title="Back to albums">
            <ArrowLeft size={20} />
          </button>
        )}
        {view.kind === 'place' && (
          <button className="icon-btn back" onClick={() => setView({ kind: 'places' })} title="Back to places">
            <ArrowLeft size={20} />
          </button>
        )}
        {currentPerson && (
          <>
            <button className="icon-btn back" onClick={() => setView({ kind: 'people' })} title="Back to people">
              <ArrowLeft size={20} />
            </button>
            <FaceAvatar
              item={byId.get(currentPerson.cover.item)}
              box={currentPerson.cover.box}
              ar={currentPerson.cover.ar}
              size={46}
              className="header-avatar"
            />
          </>
        )}
        <div className="header-titles">
          {currentPerson ? (
            <PersonName key={currentPerson.id} person={currentPerson} onRename={(name) => renamePerson(currentPerson, name)} />
          ) : currentAlbum ? (
            <AlbumTitle key={currentAlbum.id} album={currentAlbum} onRename={(name) => api.renameAlbum(currentAlbum.id, name)} />
          ) : (
            <h1>{title}</h1>
          )}
          <div className="header-sub" title={view.kind === 'folder' ? view.dir : undefined}>
            {view.kind === 'folder' ? `${view.dir} · ${subtitle}` : subtitle}
          </div>
        </div>
        <div className="spacer" />
        {currentPerson && (
          <>
            <div className="segmented small">
              <button className={personTab === 'photos' ? 'active' : ''} onClick={() => setPersonTab('photos')}>
                Photos
              </button>
              <button className={personTab === 'faces' ? 'active' : ''} onClick={() => setPersonTab('faces')}>
                Faces
              </button>
            </div>
            <button
              className="btn ghost"
              title="This is the same person as someone else"
              onClick={() =>
                setPicker({
                  title: 'Merge with…',
                  description: `Pick who ${nameOf(currentPerson)} really is. Their photos will be combined.`,
                  exclude: new Set([currentPerson.id]),
                  allowNew: false,
                  onPick: (target) => {
                    setPicker(null)
                    if ('id' in target) mergePerson(currentPerson, target)
                  },
                })
              }
            >
              <Merge size={15} /> Merge with…
            </button>
            {personMenu}
          </>
        )}
        {view.kind === 'people' && suggestions.length > 0 && (
          <button className="btn ghost" onClick={() => setReviewing(suggestions)}>
            <Sparkles size={15} /> Review suggestions
          </button>
        )}
        {view.kind === 'folder' && (
          <button className="btn ghost" onClick={() => api.revealFolder(view.dir)}>
            <FolderOpen size={15} /> Open in Explorer
          </button>
        )}
        {view.kind === 'albums' && (
          <button className="btn ghost" onClick={() => setNewAlbum(true)}>
            <Plus size={15} /> New album
          </button>
        )}
        {currentPlace && (
          <button
            className="btn ghost"
            title="Open this place in OpenStreetMap (in your browser)"
            onClick={() =>
              api.openUrl(`https://www.openstreetmap.org/?mlat=${currentPlace.lat}&mlon=${currentPlace.lon}#map=12/${currentPlace.lat}/${currentPlace.lon}`)
            }
          >
            <MapIcon size={15} /> Map
          </button>
        )}
        {currentAlbum && (
          <PopoverMenu
            items={[
              { label: 'Delete album…', icon: <Trash size={15} />, danger: true, onClick: () => deleteAlbum(currentAlbum.id) },
            ]}
            trigger={(open, toggle) => (
              <button className={`icon-btn${open ? ' on' : ''}`} onClick={toggle} title="More">
                <Ellipsis size={18} />
              </button>
            )}
          />
        )}
        {isGrid && view.kind !== 'videos' && view.kind !== 'person' && (
          <div className="segmented small">
            {(['all', 'image', 'video'] as TypeFilter[]).map((t) => (
              <button key={t} className={typeFilter === t ? 'active' : ''} onClick={() => setTypeFilter(t)}>
                {t === 'all' ? 'All' : t === 'image' ? 'Photos' : 'Videos'}
              </button>
            ))}
          </div>
        )}
        {isGrid && !(currentPerson && personTab === 'faces') && (
          <>
            <button className="btn ghost" onClick={() => setSortAsc((s) => !s)} title="Change sort order">
              <ArrowDownUp size={15} /> {sortAsc ? 'Oldest first' : 'Newest first'}
            </button>
            <label className="zoom-slider" title="Thumbnail size (Ctrl + wheel)">
              <LayoutGrid size={15} />
              <input
                type="range"
                min={ZOOM_STEPS[0]}
                max={ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                value={thumbSize}
                onChange={(e) => setThumbSize(Number(e.target.value))}
              />
            </label>
          </>
        )}
        {view.kind === 'folders' && (
          <button className="btn ghost" onClick={() => addFolders()}>
            <FolderPlus size={15} /> Add folder
          </button>
        )}
      </div>
    )
  }

  // ---------- body ----------
  const addButton = (
    <button className="btn primary large" onClick={() => addFolders()}>
      <FolderPlus size={17} /> Add a folder
    </button>
  )

  let body
  if (view.kind === 'settings') {
    body = (
      <SettingsView
        settings={settings}
        items={items}
        version={version}
        people={people}
        peopleProgress={peopleProgress}
        smartProgress={smartProgress}
        onAddFolder={() => addFolders()}
        onToast={toast}
        onConfirm={setConfirm}
      />
    )
  } else if (settings.folders.length === 0) {
    body = (
      <EmptyState
        icon={<Logo size={72} />}
        title="Welcome to Lumen"
        text="Add a folder with your photos and videos to get started. You can also drag a folder onto this window."
        action={addButton}
      />
    )
  } else if (items.length === 0) {
    body = status.scanning ? (
      <EmptyState
        icon={<LoaderCircle size={40} className="spin" />}
        title="Looking for photos and videos…"
        text={status.found ? `${formatCount(status.found)} found so far` : 'Scanning your library folders'}
      />
    ) : (
      <EmptyState
        icon={<Images size={44} strokeWidth={1.5} />}
        title="No photos or videos found"
        text="Your library folders don't contain any media yet. Add another folder to bring in more."
        action={addButton}
      />
    )
  } else if (view.kind === 'people') {
    body = (
      <PeopleView
        people={shownPeople}
        byId={byId}
        enabled={settings.faceRecognition}
        progress={peopleProgress}
        hiddenCount={people.people.filter((p) => p.hidden).length}
        showHidden={showHiddenPeople}
        smallCount={smallPeopleCount}
        showSmall={showSmallPeople}
        suggestionCount={suggestions.length}
        selection={peopleSelection}
        onToggleHidden={() => setShowHiddenPeople((s) => !s)}
        onToggleSmall={() => setShowSmallPeople((s) => !s)}
        onToggleSelect={togglePersonSelect}
        onOpen={openPerson}
        onEnable={() => api.setSettings({ faceRecognition: true })}
        onReview={() => setReviewing(suggestions)}
      />
    )
  } else if (currentPerson && personTab === 'faces') {
    body = (
      <FacesGrid
        faces={personFaces}
        byId={byId}
        selection={faceSelection}
        coverFace={currentPerson.cover.face}
        onToggle={toggleFace}
        onOpen={(face) => {
          const index = visible.findIndex((it) => it.id === face.item)
          if (index >= 0) openViewer(index)
        }}
      />
    )
  } else if (view.kind === 'folders') {
    body = visibleFolders.length ? (
      <FoldersView folders={visibleFolders} onOpen={(dir) => setView({ kind: 'folder', dir })} />
    ) : (
      <EmptyState icon={<Search size={40} strokeWidth={1.5} />} title="No folders match" text={`Nothing matches “${query}”.`} />
    )
  } else if (view.kind === 'places') {
    body = shownPlaces.length ? (
      <PlacesView
        places={shownPlaces}
        byId={byId}
        country={shownPlaces.some((p) => p.cc === placeCountry) ? placeCountry : null}
        onCountry={setPlaceCountry}
        onOpen={(id) => {
          setQuery('')
          navigate({ kind: 'place', id })
        }}
      />
    ) : query ? (
      <EmptyState icon={<Search size={40} strokeWidth={1.5} />} title="No places match" text={`No place called “${query}”.`} />
    ) : (
      <EmptyState
        icon={<MapPin size={44} strokeWidth={1.5} />}
        title="No places yet"
        text="Photos and videos that recorded where they were taken (most phones do) are grouped by town here. Place names are looked up on this computer — nothing is sent anywhere."
      />
    )
  } else if (view.kind === 'albums') {
    body =
      query && !shownAlbums.length ? (
        <EmptyState icon={<Search size={40} strokeWidth={1.5} />} title="No albums match" text={`No album called “${query}”.`} />
      ) : (
        <AlbumsView
          albums={shownAlbums}
          byId={byId}
          onCreate={() => setNewAlbum(true)}
          onOpen={(id) => {
            setQuery('')
            navigate({ kind: 'album', id })
          }}
        />
      )
  } else if (view.kind === 'duplicates') {
    body = (
      <DuplicatesView
        data={dupes}
        progress={dupesProgress}
        byId={byId}
        waiting={thumbProgress.pending > 0 || status.scanning}
        onDelete={(ids, label) => requestDelete(ids, label)}
        onDismiss={(ids) => {
          api.dismissDuplicates(ids)
          toast("Got it — they won't be suggested again")
        }}
        onOpen={(ids, index) => setViewer({ ids, index })}
      />
    )
  } else if (currentAlbum && !currentAlbum.items.some((id) => byId.has(id)) && !query) {
    body = (
      <EmptyState
        icon={<AlbumIcon size={44} strokeWidth={1.5} />}
        title="This album is empty"
        text="Select photos anywhere in Lumen and choose “Add to album” (or right-click → Add to album), or drag them onto this album in the sidebar."
        action={
          <button className="btn primary large" onClick={() => navigate({ kind: 'photos' })}>
            <Images size={17} /> Go to Photos
          </button>
        }
      />
    )
  } else if (visible.length === 0) {
    body = query ? (
      search && smart.pending ? (
        <EmptyState icon={<LoaderCircle size={40} className="spin" />} title="Searching…" text={`Looking for “${query}” in your photos.`} />
      ) : (
        <EmptyState
          icon={<Search size={40} strokeWidth={1.5} />}
          title="No results"
          text={`Nothing matches “${query}”. Try a person, place, date, file name — or describe what's in the photo, like “beach” or “birthday cake”.`}
        />
      )
    ) : view.kind === 'favorites' ? (
      <EmptyState
        icon={<Heart size={40} strokeWidth={1.5} />}
        title="No favorites yet"
        text="Tap the heart on any photo or video — or press F in the viewer — to keep it here."
      />
    ) : view.kind === 'videos' || typeFilter === 'video' ? (
      <EmptyState icon={<Film size={40} strokeWidth={1.5} />} title="No videos" text="Videos in your library folders will show up here." />
    ) : (
      <EmptyState icon={<Images size={40} strokeWidth={1.5} />} title="Nothing here" text="No items to show." />
    )
  } else {
    body = (
      <Gallery
        items={visible}
        dateField={dateField}
        thumbSize={thumbSize}
        favorites={favorites}
        selection={selection}
        resetKey={resetKey}
        focus={focus}
        onOpen={openViewer}
        onSelect={selectIndex}
        onSelectRange={selectRange}
        onZoom={zoomGrid}
        onDragItems={(ids) => (draggingIds.current = ids)}
      />
    )
  }

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (internalDrag.current || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.relatedTarget) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (internalDrag.current) return
        const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
        if (paths.length) addFolders(paths)
      }}
    >
      <TitleBar
        query={query}
        onQuery={(q) => {
          setQuery(q)
          if (view.kind === 'settings' || view.kind === 'duplicates') setView({ kind: 'photos' })
        }}
        placeholder={
          view.kind === 'folders'
            ? 'Search folders'
            : view.kind === 'people'
              ? 'Search people'
              : view.kind === 'places'
                ? 'Search places'
                : view.kind === 'albums'
                  ? 'Search albums'
                  : smartOn
                    ? 'Search people, places, dates — or what’s in the photo'
                    : 'Search by name, person, place, folder, month, year…'
        }
        inputRef={searchRef}
        version={version}
      />
      <Sidebar
        view={view}
        onNavigate={navigate}
        counts={counts}
        albums={albums}
        byId={byId}
        duplicateBytes={duplicateBytes}
        status={status}
        thumbProgress={thumbProgress}
        peopleProgress={peopleProgress}
        smartProgress={smartProgress}
        dupesProgress={dupesProgress}
        onNewAlbum={() => setNewAlbum(true)}
        canDropItems={() => internalDrag.current && draggingIds.current.length > 0}
        onDropOnAlbum={(albumId) => {
          const ids = draggingIds.current
          draggingIds.current = []
          if (ids.length) addToAlbum(albumId, ids)
        }}
      />
      <main className="content">
        {header}
        {currentPerson && (
          <PossibleMatches
            key={currentPerson.id}
            person={currentPerson}
            matches={matches}
            peopleById={peopleById}
            byId={byId}
            onMerge={(ids) => {
              api.mergePeople(ids, currentPerson.id)
              toast(`Merged ${plural(ids.length, 'group')} into ${nameOf(currentPerson)}`)
            }}
            onNotSame={(ids) => {
              for (const id of ids) api.markNotSame(currentPerson.id, id)
              toast(`Won't suggest ${ids.length === 1 ? 'that group' : 'those groups'} again`)
            }}
          />
        )}
        <div className="content-body">{body}</div>
      </main>

      {viewer && viewerIndex >= 0 && (
        <Viewer
          items={viewerItems}
          index={viewerIndex}
          favorites={favorites}
          onIndex={(index) => setViewer((v) => v && { ...v, index })}
          onClose={closeViewer}
          onToggleFavorite={(item) => {
            const v = toggleFavorite([item.id])
            toast(v ? 'Added to favorites' : 'Removed from favorites')
          }}
          onDelete={(item) => requestDelete([item.id])}
          onToast={toast}
          facesIn={facesIn}
          onOpenPerson={openPerson}
          onAssignFace={(face) =>
            moveFaces([face.faceId], face.personId ? peopleById.get(face.personId) : undefined, face.personId ? 'Change person' : "Who's this?")
          }
          onRemoveFace={(face) => rejectFaces([face.faceId], face.personId ? peopleById.get(face.personId) : undefined)}
          onAddToAlbum={(item) => setAlbumPicker([item.id])}
          placeOf={(itemId) => placeById.get(places.byItem[itemId])}
          onOpenPlace={(id) => {
            setViewer(null)
            setQuery('')
            navigate({ kind: 'place', id })
          }}
        />
      )}
      {albumPicker && (
        <AlbumPicker
          albums={albums}
          byId={byId}
          count={albumPicker.length}
          onPick={(album) => {
            const ids = albumPicker
            setAlbumPicker(null)
            addToAlbum(album.id, ids)
          }}
          onCreate={(name) => {
            const ids = albumPicker
            setAlbumPicker(null)
            createAlbumWith(name, ids)
          }}
          onClose={() => setAlbumPicker(null)}
        />
      )}
      {newAlbum && (
        <AlbumNameDialog
          title="New album"
          confirmLabel="Create"
          onClose={() => setNewAlbum(false)}
          onSubmit={async (name) => {
            setNewAlbum(false)
            const id = await createAlbumWith(name, [])
            setQuery('')
            navigate({ kind: 'album', id })
          }}
        />
      )}
      {picker && (
        <PersonPicker
          title={picker.title}
          description={picker.description}
          people={people.people}
          byId={byId}
          exclude={picker.exclude}
          allowNew={picker.allowNew}
          onPick={picker.onPick}
          onClose={() => setPicker(null)}
        />
      )}
      {reviewing && (
        <SuggestionsReview
          pairs={reviewing}
          peopleById={peopleById}
          facesByPerson={facesByPerson}
          byId={byId}
          onSame={(from, into) => api.mergePeople([from.id], into.id)}
          onDifferent={(a, b) => api.markNotSame(a.id, b.id)}
          onClose={() => setReviewing(null)}
        />
      )}
      {confirm && <ConfirmDialog options={confirm} onClose={() => setConfirm(null)} />}
      {dragOver && <DropOverlay />}
      <Toasts toasts={toasts} />
    </div>
  )
}
