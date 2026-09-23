/**
 * Package the portable Windows build.
 *
 * `@electron/packager` is used rather than an installer builder on purpose: it
 * needs nothing but the Electron zip, so it works on a clean checkout, and its
 * output is a folder the user can run straight away — no install step, no
 * uninstaller, no registry entries.
 *
 *   npm run icons && npm run dist
 *
 * That zip comes from github.com via `@electron/get`. Where github.com is
 * unreachable, point it at a mirror instead of giving up:
 *
 *   ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist
 */
import { packager } from '@electron/packager'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const outputs = await packager({
  dir: root,
  out: join(root, 'dist'),
  platform: 'win32',
  arch: 'x64',
  name: manifest.name,
  executableName: manifest.name,
  appVersion: manifest.version,
  icon: join(root, 'assets', 'icon.ico'),
  asar: true,
  overwrite: true,
  prune: true,
  // Everything the app needs at runtime is in src/ and assets/; the app has no
  // runtime dependencies at all (the collectors are vendored).
  ignore: [/^\/dist($|\/)/, /^\/test($|\/)/, /^\/capture($|\/)/, /^\/\.git($|\/)/, /\.md$/],
  win32metadata: {
    CompanyName: 'DeepSeek + DeepSeek-Harness',
    FileDescription: 'DeepSeek Harness system monitor bar',
    ProductName: manifest.name,
  },
  quiet: false,
})

for (const output of outputs) {
  const exe = join(output, `${manifest.name}.exe`)
  const size = await stat(exe).then(
    (info) => `${(info.size / 1024 / 1024).toFixed(1)} MB`,
    () => 'missing'
  )
  console.log(`[pack] ${output}`)
  console.log(`[pack]   ${manifest.name}.exe ${size}`)
}
