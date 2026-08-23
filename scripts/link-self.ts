// Make `@vzn/vx` (the root `"."` workspace member) importable by the other
// workspace members. Bun's workspace resolver cannot satisfy a member's
// `"@vzn/vx": "workspace:*"` dependency against the ROOT package — the `.`
// member is the install root, not a named package node_modules can symlink.
// So a package imports the bare specifier `'@vzn/vx'` and relies on a
// plain symlink `node_modules/@vzn/vx -> <root>`; the root's `exports` map
// then resolves `'@vzn/vx'` to `./src/index.ts`. This runs as the root's
// postinstall so a fresh `bun install` (including `--frozen-lockfile` in CI)
// re-creates it.

import {
  symlinkSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scopeDir = path.join(root, 'node_modules', '@vzn')
const link = path.join(scopeDir, 'vx')

mkdirSync(scopeDir, { recursive: true })

// Drop any stale entry (a previous run, or a real dir) before re-linking.
if (existsSync(link) || isSymlink(link)) {
  rmSync(link, { recursive: true, force: true })
}

// Relative target so the link is location-independent.
symlinkSync(path.relative(scopeDir, root), link, 'dir')

// Link the sibling workspace packages (packages/*) into node_modules/@vzn/<name>
// so a bare `import { otel } from '@vzn/vx-otel'` (e.g. in vx.workspace.ts, or
// from one package to another) resolves through each package's own exports map.
// Bun only auto-links a member that some package.json DEPENDS on; these are
// integration packages nothing declares as a dep, so we link them here — same
// idempotent re-create on a frozen install as the `@vzn/vx` self-link above.
const pkgsDir = path.join(root, 'packages')
if (existsSync(pkgsDir)) {
  for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = path.join(pkgsDir, entry.name, 'package.json')
    if (!existsSync(manifest)) continue
    const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name
    if (name === undefined || !name.startsWith('@vzn/')) continue
    const pkgLink = path.join(root, 'node_modules', ...name.split('/'))
    mkdirSync(path.dirname(pkgLink), { recursive: true })
    if (existsSync(pkgLink) || isSymlink(pkgLink)) rmSync(pkgLink, { recursive: true, force: true })
    symlinkSync(
      path.relative(path.dirname(pkgLink), path.join(pkgsDir, entry.name)),
      pkgLink,
      'dir',
    )
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
