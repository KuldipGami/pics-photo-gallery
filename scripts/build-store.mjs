// Builds the Microsoft Store package (release/v<version>/Pics <version>.appx) for upload to Partner
// Center; the Store signs it. Run with: npm run store
//
// electron-builder's own makeappx.exe lacks the side-by-side DLLs it needs, so this uses the one from
// Microsoft's "Microsoft.Windows.SDK.BuildTools" NuGet package, unpacked (bin\<sdk>\x64) into .winsdk\x64
// (or the folder in ELECTRON_BUILDER_WINDOWS_KITS_PATH). On some PCs Windows won't load it from a folder
// directly under %LOCALAPPDATA%, so it lives in the project.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const kit = process.env.ELECTRON_BUILDER_WINDOWS_KITS_PATH || join(root, '.winsdk', 'x64')
if (!existsSync(join(kit, 'makeappx.exe')) || !existsSync(join(kit, 'appxpackaging.dll'))) {
  console.error(`makeappx.exe (with appxpackaging.dll next to it) wasn't found in ${kit}.
Download Microsoft.Windows.SDK.BuildTools from nuget.org, open the .nupkg as a zip and copy
bin\\<version>\\x64 to .winsdk\\x64 (or set ELECTRON_BUILDER_WINDOWS_KITS_PATH to that folder).`)
  process.exit(1)
}
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_BUILDER_WINDOWS_KITS_PATH: kit } })
run('npx vite build')
run(`npx electron-builder --win appx -c.directories.output=release/v${version}`)
