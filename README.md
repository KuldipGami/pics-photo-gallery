# Lumen

A modern photo & video gallery for your desktop. Built with Electron, React and TypeScript.

![icon](resources/icon.png)

## Features

- **Timeline** of every photo and video in your folders, grouped by day (or by month when zoomed out), with a Google Photos–style date scrubber.
- **Fast with big libraries** — virtualised GPU-composited grid, previews generated in parallel on every CPU core (libvips) and the GPU's hardware video decoder, built for the whole library in the background, cached on disk, live folder watching.
- **Real capture dates** from EXIF (photos) and MP4/MOV metadata (videos), falling back to file dates.
- **Viewer** — zoom & pan (wheel, double-click, drag), filmstrip, slideshow, video playback with seeking, blurred ambient backdrop, details panel (camera, lens, exposure, GPS).
- **People** — photos grouped by the faces in them, on-device. Name people (then search by name) and fix any grouping by hand:
  - **Same person?** review of likely duplicate groups (keyboard **Y** / **N** / **S**); "different" answers are remembered.
  - **Possible matches** on each person's page — tick the groups that are the same person and merge them at once.
  - **Multi-select** on the People page → *Merge* / *Hide*. Small groups (1–2 photos) are tucked away behind a "show" button.
  - **Faces** tab per person, least-similar faces first, so wrong matches surface at the top.
  - **Move to…** another person or a new one, **Not this person**, **Use as cover**, **Remove person** — on photos or individual faces.
  - In the viewer's details panel every face gets a chip (unrecognised ones say "Who's this?"); hover it to outline the face in the photo. Faces are found and recognised on the GPU with **InsightFace** (SCRFD-10G detector + ArcFace ResNet-50, "buffalo_l") on ONNX Runtime / DirectML; nothing is uploaded, and *Settings → People* shows where the model runs and can turn it off or delete all face data. The InsightFace pretrained models are licensed for **non-commercial use only**.
- **Search by what's in the photo** — type “beach”, “dog”, “birthday cake” or “receipt” and Lumen finds matching photos and videos, with no tags needed. Words that name a person, place or date filter strictly, so “goa beach 2023” means beach photos taken in Goa in 2023. It uses Google's **SigLIP** model (Apache 2.0) on the GPU through ONNX Runtime / DirectML (about 8 ms per photo on an RTX 4070); nothing is uploaded.
- **Places** — photos and videos with a GPS position, grouped by town and filterable by country, plus the place name in the details panel. Place names come from a bundled copy of **GeoNames** (161k towns, CC BY 4.0) and are looked up offline. Phone videos' locations are read too.
- **Memories** — **trips** found automatically from where and when photos were taken (home bases are the places you keep returning to; photos without a location taken during a trip, in the same folders, are included), and **On this day**: photos from today's date in earlier years, as a strip above Photos and on the Memories page.
- **Edit photos** — rotate, flip, straighten, crop (free or fixed proportions, dragged on the photo), auto-enhance, light, contrast, colour and warmth, with a live preview rendered by the same code that saves. Edits are always **saved as a new copy** next to the original (capture date, camera and place kept); HEIC/RAW are decoded at full size by Windows.
- **Videos** — hover a video (or Live Photo) to play a silent preview; long videos remember where you stopped; **Live Photos** (an iPhone still + its short clip) show as one photo with a LIVE button.
- **Albums** — your own collections. Add items from the selection bar, the right-click menu or the viewer, or drag them onto an album in the sidebar. You can rename an album, change its cover or remove items; deleting an album never deletes files.
- **Duplicates** — **exact copies** (identical bytes; extra copies can be removed in one click) and **look-alikes** (the same picture resized, re-saved by a messenger, edited or shot in a burst). The original or sharpest copy is suggested, you can keep a different one, and "Not duplicates" hides a group for good. Removed files go to the Recycle Bin.
- **Library tools** — Favorites, Recently added, Folders, search (name, person, place, folder, month, year, camera, content), multi-select (Ctrl/Shift-click), move to Recycle Bin, copy image, drag files out to other apps, right-click menu.
- **Windows 11 look** — Mica window material, light/dark/system theme, accent colors.
- **Uses the discrete GPU** (e.g. NVIDIA RTX) on dual-graphics laptops — see *Settings → Performance*, which also shows the GPU in use.
- **Version badge** in the title bar. Launching a newer build while an older one (1.2+) is open closes the old one automatically.
- HEIC/TIFF/RAW previews when the matching Windows codec extensions are installed.

## Run it

```bash
npm install
npm run models
npm run dev
```

`npm run models` downloads into `models/`:
- the face-recognition models (InsightFace buffalo_l, ~182 MB extracted);
- the smart-search model (SigLIP base, fp16 ONNX, ~392 MB), plus its two calibration numbers read from Google's checkpoint;
- the GeoNames town list, reduced to `places.json.gz` (~2 MB).

`npm run dev` starts Vite with hot reload for the UI and restarts Electron when files in `electron/` change.

## Build an installer

```bash
npm run dist
```

The installer is written to `release/`.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Ctrl F | Search |
| Ctrl + / Ctrl − (or Ctrl + wheel) | Bigger / smaller thumbnails |
| Ctrl A, Ctrl/Shift + click | Select all / select / select range |
| Del | Move to Recycle Bin |
| F5 | Rescan library |
| ← → Home End | Navigate in the viewer |
| Space | Slideshow · play/pause video |
| F / I | Favorite / details panel |
| E | Edit photo (Ctrl S save copy, Ctrl Z reset, Esc close) |
| L | Play a Live Photo |
| + − 0 | Zoom in / out / fit |

## Project layout

```
electron/          main process (CommonJS, no build step)
  main.cjs         window, IPC, context menu
  library.cjs      folder scanning, EXIF/MP4 metadata, index cache, watching
  thumbs.cjs       thumbnail engine: priority queues, sharp/libvips for photos, disk cache,
                   background pre-generation
  workers.cjs      hidden worker windows (GPU video frames, OS thumbnails for HEIC/RAW)
  worker.cjs       code that runs inside those workers
  faces.cjs        People: face index (faces.json), analysis queue, names/merges/corrections,
                   upgrade from older face models (carries the user's choices over)
  face-engine.cjs  InsightFace engine process: SCRFD detection, 5-point alignment, ArcFace
                   512-d faceprints on ONNX Runtime (DirectML GPU, fastest adapter picked)
  faces-cluster.cjs  groups faceprints into people (worker thread; density-based, incremental)
  smart.cjs        smart search: SigLIP embedding per item (smart.bin), text queries, ranking
  smart-engine.cjs SigLIP engine process (image + text encoders, SentencePiece tokenizer, DirectML)
  places.cjs       offline reverse geocoding (GeoNames), photos grouped by town
  duplicates.cjs   exact copies (content hash) and look-alikes (128-bit visual hash), cached
  albums.cjs       albums (albums.json)
  editor.cjs       photo edits (rotate, straighten, crop, light & colour) saved as copies
  protocol.cjs     gallery:// protocol (files, thumbnails, range requests for video)
  preload.cjs      safe bridge exposed to the UI as window.lumen
src/               React UI (Vite)
  App.tsx          state, filtering, keyboard shortcuts
  components/      Gallery, Viewer, FoldersView, SettingsView, …
  lib/             date formatting, grid layout, video thumbnail fallback
resources/         app icon (icon.svg → icon.png via `npm run icon`)
models/            AI models + place names (npm run models; bundled into the installer)
```

## How previews stay fast

Measured on a 2,000-file library (1,800 × 12 MP JPEGs + 200 × 1080p videos):

| | v1.0 | v1.1 |
| --- | --- | --- |
| Jump anywhere in the timeline (not cached yet) | 1.4–2.1 s | 0.14–0.4 s |
| Land after a fast fling | 30 s | 0.4 s |
| Main process frozen (total) | 88 s | < 1 s |
| Whole library ready | — | ~14 s, then instant on every launch |

- Photos are decoded by **sharp/libvips** (SIMD, JPEG shrink-on-load) on a thread pool sized to the CPU, instead of one at a time on the main thread.
- Video frames come from the **GPU's hardware decoder** in a hidden worker window.
- Formats only Windows can decode (HEIC, RAW) use the shell thumbnailer **in 4 worker processes** (≈9× faster than one), so the app never blocks.
- Windows picks the integrated GPU for Chromium by default; Lumen sets `force_high_performance_gpu`, which roughly halves HEVC/H.264 video preview time on an RTX 4070.
- On-screen previews always jump the queue; while you fling or drag the scrubber, nothing loads until you land.

Settings, the library index, the thumbnail cache, faces, albums, the search index and the duplicate cache live in `%APPDATA%\Lumen`.
Lumen never modifies your files — the only write action is *Move to Recycle Bin*, which always asks first.
