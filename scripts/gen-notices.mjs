// Builds resources/licenses/THIRD-PARTY-NOTICES.txt from the license files in node_modules.
// Run after updating dependencies: node scripts/gen-notices.mjs
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? join(import.meta.dirname, '..')
const nm = join(root, 'node_modules')
const out = join(root, 'resources', 'licenses')
const W = 80

const norm = (t) =>
  t
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
const read = (...p) => norm(readFileSync(join(...p), 'utf8'))
const pkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
const ver = (name) => pkg(join(nm, name)).version
const lines = (from, a, b) => from.split('\n').slice(a - 1, b).join('\n')

const rule = (c) => c.repeat(W)
const chapter = (title) => `\n\n${rule('=')}\n${title}\n${rule('=')}\n`
const entry = (title, head, text) => `\n${rule('-')}\n${title}\n${rule('-')}\n${head.filter((l) => l != null).join('\n')}${text ? `\n\n${text}` : ''}\n`

const repoUrl = (p) => {
  let r = typeof p.repository === 'string' ? p.repository : p.repository?.url
  if (!r) return p.homepage ?? ''
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`
  r = r.replace(/^github:/, 'https://github.com/').replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://')
  return r.replace(/\.git$/, '')
}

function licenseFile(dir) {
  const f = readdirSync(dir).find((f) => /^(licen[cs]e|copying|mit-licen[cs]e)(\.(md|txt))?$/i.test(f))
  if (f) return read(dir, f)
  // a few packages keep the license only in the README
  const readme = readdirSync(dir).find((f) => /^readme\.md$/i.test(f))
  if (readme) {
    const m = readFileSync(join(dir, readme), 'utf8').replace(/\r\n?/g, '\n').match(/\nLicense\n-+\n\n([\s\S]*?)(\n\[|$)/)
    if (m) return norm(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
  }
  return null
}

const MIT = (copyright) => `MIT License

${copyright}

${lines(read(nm, 'react', 'LICENSE'), 5, 21)}`

const apache = read(nm, 'detect-libc', 'LICENSE')
const gpl3 = read(nm, 'ffmpeg-static', 'ffmpeg.exe.LICENSE')
const lgpl3Path = join(import.meta.dirname, 'licenses', 'LGPL-3.0.txt') // verbatim FSF text
const lgpl3 = readFileSync(lgpl3Path, 'utf8').replace(/\r\n?/g, '\n').replace(/^\t+/gm, (t) => '        '.repeat(t.length)).replace(/\n+$/, '')
if (!/^\s*GNU LESSER GENERAL PUBLIC LICENSE\n\s*Version 3, 29 June 2007/.test(lgpl3)) throw new Error('LGPL-3.0 text not found')

// ---------- sharp / libvips table ----------
const sharpReadme = read(nm, '@img', 'sharp-win32-x64', 'README.md')
const vipsVersions = JSON.parse(readFileSync(join(nm, '@img', 'sharp-win32-x64', 'versions.json'), 'utf8'))
const vipsKey = (name) => {
  const k = name.replace(/^lib(?!vips)/, '').replace(/^ultrahdr$/, 'uhdr')
  return vipsVersions[k] ?? vipsVersions[name] ?? vipsVersions[name.replace(/^lib/, '')]
}
const vipsRows = [...sharpReadme.matchAll(/^\| (\S+)\s*\| (.+?)\s*\|$/gm)]
  .filter((m) => !/^(Library|-+)$/.test(m[1]))
  .map(([, name, lic]) => {
    const text = lic.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    const v = vipsKey(name)
    return `  ${(name + (v ? ' ' + v : '')).padEnd(24)} ${text}`
  })
const lgplLibs = [...sharpReadme.matchAll(/^\| (\S+)\s*\| LGPLv3\s*\|$/gm)].map((m) => m[1])

// ---------- supporting packages (everything else electron-builder copies into the app) ----------
const covered = new Set([
  'exifr', 'ffmpeg-static', 'leaflet', 'leaflet.markercluster', 'onnxruntime-node', 'onnxruntime-common', 'sharp', '@img/sharp-win32-x64',
])
const tree = execSync('npm ls --omit=dev --all --parseable', {
  cwd: root,
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/)
  .slice(1)
const supporting = []
const seen = new Set()
for (const dir of tree) {
  if (!existsSync(join(dir, 'package.json'))) continue
  const p = pkg(dir)
  const id = `${p.name}@${p.version}`
  if (covered.has(p.name) || seen.has(id)) continue
  seen.add(id)
  const text = licenseFile(dir)
  if (!text) throw new Error(`No license text for ${id}`)
  const lic = typeof p.license === 'string' ? p.license : (p.licenses ?? []).map((l) => l.type).join(' / ')
  supporting.push({ name: p.name, version: p.version, license: lic, url: repoUrl(p), text })
}
supporting.sort((a, b) => a.name.replace(/^@/, '').localeCompare(b.name.replace(/^@/, '')))

// ---------- document ----------
const v = {
  electron: ver('electron'),
  react: ver('react'),
  reactDom: ver('react-dom'),
  scheduler: ver('scheduler'),
  lucide: ver('lucide-react'),
  leaflet: ver('leaflet'),
  cluster: ver('leaflet.markercluster'),
  exifr: ver('exifr'),
  sharp: ver('sharp'),
  sharpWin: ver('@img/sharp-win32-x64'),
  ort: ver('onnxruntime-node'),
  ffmpegStatic: ver('ffmpeg-static'),
  vite: ver('vite'),
  rolldown: ver('rolldown'),
  builder: ver('electron-builder'),
  vips: vipsVersions.vips,
}
const ffmpegReadme = read(nm, 'ffmpeg-static', 'ffmpeg.exe.README')
const ffmpegBuild = ffmpegReadme.match(/^Version: (.+)$/m)[1]
const ffmpegSource = ffmpegReadme.match(/^Source Code: (.+)$/m)[1]
const ffmpegTag = pkg(join(nm, 'ffmpeg-static'))['ffmpeg-static']['binary-release-tag']

let doc = `LUMEN - THIRD-PARTY NOTICES
${rule('=')}

Lumen includes software, AI models and data made by others. Each part keeps its
own license. This file lists them with the copyright notices and license texts
that those licenses ask to be passed on.

Where things are in the folder Lumen is installed in:
  LICENSE.electron.txt, LICENSES.chromium.html   next to Lumen.exe
  resources\\licenses\\                            this file and ffmpeg-source.txt
  resources\\app.asar.unpacked\\node_modules\\      ffmpeg, sharp/libvips, ONNX Runtime
  resources\\models\\                              the AI models and place names

Contents
  1. Please note: restrictions and source code
  2. Electron, Chromium and Node.js
  3. The Lumen window: React, Lucide icons, Leaflet, build tools
  4. Photo and video engines: exifr, sharp/libvips, ONNX Runtime, DirectML, FFmpeg
  5. AI models and data: InsightFace, SigLIP, LaMa, GeoNames
  6. The map: OpenStreetMap
  7. Windows features Lumen uses
  8. Supporting packages
  Appendix A. Apache License 2.0
  Appendix B. GNU General Public License, version 3
  Appendix C. GNU Lesser General Public License, version 3`

doc += chapter('1. PLEASE NOTE: RESTRICTIONS AND SOURCE CODE')
doc += `
* Face recognition (People) uses the InsightFace "buffalo_l" models. InsightFace
  makes these models available for NON-COMMERCIAL RESEARCH PURPOSES ONLY. Do not
  use Lumen's face recognition commercially. It can be switched off in
  Settings > People. See section 5.1.

* FFmpeg (ffmpeg.exe) is a separate program that Lumen runs to save edited videos
  and make memory movies. It is licensed under the GNU General Public License,
  version 3 (Appendix B). Where to get its complete source code is explained in
  ffmpeg-source.txt next to this file and in section 4.5.

* libvips and several of the libraries it is built with are licensed under the
  GNU Lesser General Public License, version 3 (Appendix C). They are separate
  DLL files that you may replace with your own build. See section 4.2.

* Place names come from GeoNames (CC BY 4.0). Map images come from OpenStreetMap
  (c) OpenStreetMap contributors, and are loaded over the internet only while a
  map is on screen. See sections 5.4 and 6.

Lumen runs on your computer: your photos, faces, text and searches are analysed
there and are not uploaded. The only internet use is loading map images while a
map is open, and the web pages you choose to open from Lumen.`

doc += chapter('2. ELECTRON, CHROMIUM AND NODE.JS')
doc += entry(
  `2.1 Electron ${v.electron}`,
  ['Copyright (c) Electron contributors', 'Copyright (c) 2013-2020 GitHub Inc.', 'License: MIT', repoUrl(pkg(join(nm, 'electron'))), '(Also in LICENSE.electron.txt next to Lumen.exe.)'],
  read(nm, 'electron', 'LICENSE'),
)
doc += entry(
  '2.2 Chromium, V8, Node.js and the other parts of Electron',
  [
    'Electron contains Chromium, the V8 JavaScript engine, Node.js and hundreds of',
    'other open-source projects (among them Chromium\'s own FFmpeg build under the',
    'LGPL, and the DirectX Shader Compiler). Their copyright notices and license',
    'texts are in LICENSES.chromium.html, in the folder where Lumen is installed',
    '(next to Lumen.exe). Open it in a web browser to read it.',
  ],
)
doc += entry(
  `2.3 electron-builder ${v.builder} (installer and uninstaller)`,
  [
    'Copyright (c) 2015 Loopline Systems',
    'License: MIT',
    repoUrl(pkg(join(nm, 'electron-builder'))),
    'The installer itself is made with NSIS (https://nsis.sourceforge.io), which is',
    'licensed under the zlib/libpng license.',
  ],
  read(nm, 'electron-builder', 'LICENSE'),
)

doc += chapter('3. THE LUMEN WINDOW')
doc += entry(
  `3.1 React ${v.react}, React DOM ${v.reactDom}, scheduler ${v.scheduler}`,
  ['Copyright (c) Meta Platforms, Inc. and affiliates.', 'License: MIT', 'https://react.dev  -  ' + repoUrl(pkg(join(nm, 'react'))).replace(/\/tree.*$/, '')],
  read(nm, 'react', 'LICENSE'),
)
doc += entry(
  `3.2 Lucide icons (lucide-react ${v.lucide})`,
  ['Copyright (c) 2026 Lucide Icons and Contributors', 'Some icons: Copyright (c) 2013-present Cole Bemis (Feather)', 'License: ISC; the icons derived from Feather: MIT', 'https://lucide.dev'],
  read(nm, 'lucide-react', 'LICENSE'),
)
doc += entry(
  `3.3 Leaflet ${v.leaflet}`,
  ['Copyright (c) 2010-2023, Volodymyr Agafonkin', 'Copyright (c) 2010-2011, CloudMade', 'License: BSD 2-Clause', 'https://leafletjs.com'],
  read(nm, 'leaflet', 'LICENSE'),
)
doc += entry(
  `3.4 Leaflet.markercluster ${v.cluster}`,
  ['Copyright 2012 David Leaver', 'License: MIT', repoUrl(pkg(join(nm, 'leaflet.markercluster')))],
  read(nm, 'leaflet.markercluster', 'MIT-LICENCE.txt'),
)
doc += entry(
  `3.5 Vite ${v.vite} and Rolldown ${v.rolldown} (small helpers built into the window's code)`,
  ['Copyright (c) 2019-present, VoidZero Inc. and Vite contributors', 'Copyright (c) 2024-present VoidZero Inc. & Contributors (Rolldown)', 'License: MIT', 'https://vite.dev  -  https://rolldown.rs'],
  `${lines(read(nm, 'vite', 'LICENSE.md'), 4, 24)}\n\n${lines(read(nm, 'rolldown', 'LICENSE'), 1, 21)}`,
)

doc += chapter('4. PHOTO AND VIDEO ENGINES')
doc += entry(
  `4.1 exifr ${v.exifr} (reads photo dates, places and camera details)`,
  ['Copyright (c) 2020 Mike Kovařík, Mutiny.cz', 'License: MIT', repoUrl(pkg(join(nm, 'exifr')))],
  read(nm, 'exifr', 'LICENSE'),
)
doc += entry(
  `4.2 sharp ${v.sharp} and libvips ${v.vips} (thumbnails, edits, conversions)`,
  [
    'sharp: Copyright 2013 Lovell Fuller and others.',
    'License: Apache License 2.0 (Appendix A)',
    'https://sharp.pixelplumbing.com  -  https://github.com/lovell/sharp',
    '',
    `The Windows build of sharp (@img/sharp-win32-x64 ${v.sharpWin}) contains libvips`,
    `${v.vips} and the libraries below, as two DLL files:`,
    '  resources\\app.asar.unpacked\\node_modules\\@img\\sharp-win32-x64\\lib\\',
    `    libvips-42.dll, libvips-cpp-${v.vips}.dll`,
    'Its license is "Apache-2.0 AND LGPL-3.0-or-later". The libraries are used under',
    'these terms (from the package\'s README):',
    '',
    ...vipsRows,
    '',
    'Use of libraries under the terms of the LGPLv3 is via the "any later version"',
    'clause of the LGPLv2 or LGPLv2.1.',
    '',
    `LGPL libraries: ${lgplLibs.join(', ')}.`,
    'They are covered by the GNU LGPL version 3 (Appendix C, together with the GNU',
    'GPL version 3 in Appendix B). Lumen uses them only through the DLL files above;',
    'you may replace those files with your own build of the same libvips version.',
    '',
    'Source code:',
    `  libvips ${v.vips}       https://github.com/libvips/libvips (tag v${v.vips})`,
    '  build of these DLLs  https://github.com/lovell/sharp-libvips (build scripts and',
    '                       the exact versions above; each library\'s source is',
    '                       published by its own project)',
  ],
)
doc += entry(
  `4.3 ONNX Runtime ${v.ort} (runs the AI models; onnxruntime-node, onnxruntime-common)`,
  [
    'Copyright (c) Microsoft Corporation',
    'License: MIT',
    'https://onnxruntime.ai  -  https://github.com/microsoft/onnxruntime',
    'onnxruntime.dll also contains open-source components listed in ONNX Runtime\'s',
    `ThirdPartyNotices.txt: https://github.com/microsoft/onnxruntime/blob/v${v.ort}/ThirdPartyNotices.txt`,
    '(The npm package does not include a license file; this is the MIT License as',
    'published in the ONNX Runtime repository.)',
  ],
  MIT('Copyright (c) Microsoft Corporation'),
)
doc += entry(
  '4.4 DirectML and DirectX Shader Compiler (run the AI models on the graphics card)',
  [
    'DirectML.dll - DirectML Redistributable 1.15.4',
    '  (c) Microsoft Corporation. All rights reserved.',
    '  Redistributed with ONNX Runtime under Microsoft\'s license terms for the',
    '  DirectML redistributable: https://www.nuget.org/packages/Microsoft.AI.DirectML/1.15.4',
    '  https://github.com/microsoft/DirectML',
    'dxcompiler.dll, dxil.dll - DirectX Shader Compiler 1.8.2502',
    '  (c) Microsoft Corporation. All rights reserved.',
    '  dxcompiler is licensed under the University of Illinois/NCSA Open Source',
    '  License (see "DirectX-Shader-Compiler" in LICENSES.chromium.html); dxil.dll is',
    '  a Microsoft redistributable. https://github.com/microsoft/DirectXShaderCompiler',
  ],
)
doc += entry(
  `4.5 FFmpeg 6.0 (ffmpeg.exe: saving edited videos, memory movies)`,
  [
    `Build: ${ffmpegBuild}, a 64-bit static Windows build by`,
    '  Gyan Doshi (https://www.gyan.dev/ffmpeg/builds/)',
    `Delivered by the ffmpeg-static ${v.ffmpegStatic} npm package, binary release ${ffmpegTag}:`,
    `  https://github.com/eugeneware/ffmpeg-static/releases/tag/${ffmpegTag}`,
    'Copyright (c) 2000-2023 the FFmpeg developers',
    'License: GNU General Public License, version 3 (Appendix B; also in',
    '  ffmpeg.exe.LICENSE next to ffmpeg.exe). The build is configured with',
    '  --enable-gpl --enable-version3 and includes GPL libraries such as x264 and',
    '  x265, so the program as a whole is under the GPLv3.',
    `Source code: FFmpeg ${ffmpegSource}`,
    '  and the build details in ffmpeg.exe.README next to ffmpeg.exe. More in',
    '  ffmpeg-source.txt next to this file.',
    'Location: resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe',
    'Lumen runs ffmpeg.exe as a separate program; it is not part of Lumen\'s code.',
    '',
    `The ffmpeg-static ${v.ffmpegStatic} package (the small script that finds ffmpeg.exe) is by`,
    'Eugene Ware, Jannis R and contributors, licensed under the GNU GPL version 3',
    'or later (Appendix B). https://github.com/eugeneware/ffmpeg-static',
  ],
)

doc += chapter('5. AI MODELS AND DATA')
doc += entry(
  '5.1 InsightFace "buffalo_l" face models (People)',
  [
    'Files: resources\\models\\det_10g.onnx (face detection, SCRFD)',
    '       resources\\models\\w600k_r50.onnx (face recognition, ArcFace ResNet-50)',
    'From: InsightFace, https://github.com/deepinsight/insightface (release v0.7)',
    'By: the InsightFace project (Jia Guo, Jiankang Deng and contributors)',
    '',
    'LICENSE: NON-COMMERCIAL RESEARCH USE ONLY.',
    'The InsightFace code is MIT-licensed, but InsightFace makes its pretrained',
    'models, including buffalo_l, available for non-commercial research purposes',
    'only. Lumen\'s face recognition is therefore only for personal, non-commercial',
    'use. For any commercial use, switch face recognition off (Settings > People)',
    'or obtain a commercial license from InsightFace.',
  ],
)
doc += entry(
  '5.2 SigLIP base patch16-224 (Search by what\'s in the photo)',
  [
    'Files: resources\\models\\siglip\\vision_model_fp16.onnx, text_model_fp16.onnx,',
    '       tokenizer.json, calibration.json',
    'Model: Google, "Sigmoid Loss for Language Image Pre-Training" (Zhai, Mustafa,',
    '  Kolesnikov, Beyer, 2023). (c) Google LLC.',
    '  https://huggingface.co/google/siglip-base-patch16-224',
    'ONNX export: Xenova, https://huggingface.co/Xenova/siglip-base-patch16-224',
    'License: Apache License 2.0 (Appendix A)',
    'calibration.json holds two numbers (logit scale and bias) read from Google\'s',
    'original model file.',
  ],
)
doc += entry(
  '5.3 LaMa "big-lama" inpainting (Magic eraser)',
  [
    'File: resources\\models\\lama\\lama.onnx',
    'Model: "Resolution-robust Large Mask Inpainting with Fourier Convolutions"',
    '  (Suvorov et al., 2021), Samsung AI Center Moscow.',
    '  https://github.com/advimman/lama',
    'ONNX export: Carve, https://huggingface.co/Carve/LaMa-ONNX',
    '  (revision c3c0c9e468934d62e79c329e35d82dd09ff8c444, lama_fp32.onnx)',
    'License: Apache License 2.0 (Appendix A)',
    '',
    'Changed by Lumen: the file was modified so that it runs with DirectML. Its',
    'batched 5-D Fourier-transform matrix multiplications were rewritten as',
    'equivalent 4-D ones, its shape calculations were replaced by constants for',
    'the fixed 512 x 512 input, and the graph was simplified with ONNX Runtime\'s',
    'basic optimizer. The trained weights are unchanged.',
  ],
)
doc += entry(
  '5.4 GeoNames place names (Places)',
  [
    'File: resources\\models\\places.json.gz',
    'Data: GeoNames, https://www.geonames.org (cities1000, admin1CodesASCII,',
    '  countryInfo from https://download.geonames.org/export/dump/)',
    'License: Creative Commons Attribution 4.0 International (CC BY 4.0)',
    '  https://creativecommons.org/licenses/by/4.0/',
    'Changed by Lumen: reduced to populated places with their region and country',
    'names. Parts of cities and historical, abandoned or destroyed places are left',
    'out, and city districts listed as towns of their own are merged into their',
    'city. GeoNames provides the data "as is", without warranty.',
  ],
)

doc += chapter('6. THE MAP')
doc += entry(
  '6.1 OpenStreetMap',
  [
    'Map data (c) OpenStreetMap contributors, available under the Open Database',
    'License (ODbL) 1.0: https://www.openstreetmap.org/copyright',
    'The map images (tiles) are loaded from tile.openstreetmap.org, run by the',
    'OpenStreetMap Foundation, under its tile usage policy:',
    '  https://operations.osmfoundation.org/policies/tiles/',
    'They are loaded over the internet only while the Map or a place picker is on',
    'screen, and only for the area shown. The attribution is shown on the map.',
  ],
)

doc += chapter('7. WINDOWS FEATURES LUMEN USES')
doc += `
These are parts of Windows that Lumen asks Windows to use. They are not included
with Lumen and are covered by your Windows license.

  Windows text recognition (Windows.Media.Ocr)   Text in photos
  Windows Hello                                  Unlocking Private
  HEIF Image Extensions, HEVC Video Extensions   HEIC photos and HEVC videos
    (Microsoft Store)
  Windows thumbnail and image decoders           RAW, HEIC and other formats
`

doc += chapter('8. SUPPORTING PACKAGES')
doc += `
These small packages come with the libraries above (mostly for their installers)
and are copied into Lumen with them.
`
// group packages whose license text is identical
const groups = []
for (const s of supporting) {
  const g = groups.find((x) => x.text === s.text)
  if (g) g.items.push(s)
  else groups.push({ text: s.text, items: [s] })
}
for (const g of groups) {
  const isApache = /Apache License\s+Version 2\.0/i.test(g.text)
  const title = g.items.map((s) => `${s.name} ${s.version}`).join(', ')
  const head = g.items.map((s) => `${s.name}: ${s.license}  ${s.url}`)
  doc += entry(title, head, isApache ? 'Licensed under the Apache License 2.0 (Appendix A).' : g.text)
}

doc += chapter('APPENDIX A. APACHE LICENSE 2.0')
doc += `\n${apache}\n`
doc += chapter('APPENDIX B. GNU GENERAL PUBLIC LICENSE, VERSION 3')
doc += `\n${gpl3}\n`
doc += chapter('APPENDIX C. GNU LESSER GENERAL PUBLIC LICENSE, VERSION 3')
doc += `\n${lgpl3}\n`

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'THIRD-PARTY-NOTICES.txt'), doc.replace(/^\n+/, '') + '\n')
console.log('wrote', join(out, 'THIRD-PARTY-NOTICES.txt'), doc.length, 'chars,', supporting.length, 'supporting packages')
