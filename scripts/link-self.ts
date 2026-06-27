// Make `@vzn/vx` (the root `"."` workspace member) importable by the other
// workspace members. Bun's workspace resolver cannot satisfy a member's
// `"@vzn/vx": "workspace:*"` dependency against the ROOT package — the `.`
// member is the install root, not a named package node_modules can symlink.
// So packages/cloud imports the bare specifier `'@vzn/vx'` and relies on a
// plain symlink `node_modules/@vzn/vx -> <root>`; the root's `exports` map
// then resolves `'@vzn/vx'` to `./src/index.ts`. This runs as the root's
// postinstall so a fresh `bun install` (including `--frozen-lockfile` in CI)
// re-creates it.

import { symlinkSync, mkdirSync, existsSync, lstatSync, rmSync, chmodSync } from 'node:fs'
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

// Expose the `vx-cloud` bin on node_modules/.bin so `bunx vx-cloud` (and a
// PATH that includes node_modules/.bin) launch the service CLI in-repo. Bun
// does not auto-link a workspace member's bin to the root .bin under the
// self-link layout above, so we create it here — same postinstall, same
// idempotent re-create on a frozen install.
const binDir = path.join(root, 'node_modules', '.bin')
const binLink = path.join(binDir, 'vx-cloud')
const binTarget = path.join(root, 'packages', 'cloud', 'src', 'cli', 'bin.ts')
mkdirSync(binDir, { recursive: true })
chmodSync(binTarget, 0o755) // the shebang makes it directly executable via the symlink
if (existsSync(binLink) || isSymlink(binLink)) {
  rmSync(binLink, { force: true })
}
symlinkSync(path.relative(binDir, binTarget), binLink, 'file')

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}
