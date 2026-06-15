// `vx upgrade [tag]` — self-update the compiled binary in place.
// Mirrors install.sh: download the release asset for this os/arch,
// write next to the current executable, atomic rename over it.
// Named `upgrade` (not `update`) per CLI convention: bun upgrade,
// deno upgrade — "update" is what package managers do to indexes.

import { chmod, rename, rm } from 'node:fs/promises'
import { UserError } from '../util/index.js'
import { VERSION } from '../version.js'

const REPO = 'vznjs/vx'

/**
 * A Bun standalone-binary path lives under the bunfs virtual root.
 * Marker differs by platform / Bun version: `/$bunfs/...` (posix) and
 * `B:\~BUN\...` or `B:/~BUN/...` (windows).
 */
export function isBunfsPath(p: string): boolean {
  return p.startsWith('/$bunfs') || p.startsWith('B:\\~BUN') || p.startsWith('B:/~BUN')
}

/**
 * True when running as a `bun build --compile` binary. Keys off
 * `Bun.main` (and argv[1]) rather than `import.meta.path`: with
 * `--minify --bytecode` — vx's release build flags — `import.meta.path`
 * reports the ORIGINAL SOURCE path, not the bunfs path, so the old
 * check silently failed for every curl-installed binary and `vx
 * upgrade` refused with "running from source". `Bun.main` stays the
 * bunfs path under every compile-flag combination.
 */
function isCompiledBinary(): boolean {
  return (
    isBunfsPath(Bun.main) || isBunfsPath(process.argv[1] ?? '') || isBunfsPath(import.meta.path)
  )
}

function assetName(): string {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : null
  if ((os !== 'darwin' && os !== 'linux') || arch === null) {
    throw new UserError(`vx upgrade: unsupported platform ${process.platform}/${process.arch}`)
  }
  return `vx-${os}-${arch}`
}

/**
 * Download `url` and atomically replace `dest` with it. Exported for
 * tests (which point `url` at a local server and `dest` at a tmp
 * file); the CLI wires it to the GitHub release asset and
 * process.execPath.
 */
export async function replaceBinary(dest: string, url: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new UserError(`vx upgrade: download failed (${res.status}) — ${url}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new UserError(`vx upgrade: empty download — ${url}`)
  }
  const tmp = `${dest}.upgrade-${process.pid}`
  try {
    await Bun.write(tmp, bytes)
    await chmod(tmp, 0o755)
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { force: true })
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `vx upgrade: could not replace ${dest} (${msg}) — ` +
        `check permissions, or reinstall via install.sh with VX_INSTALL_DIR set`,
    )
  }
}

export async function upgradeCmd(args: readonly string[]): Promise<number> {
  const tag = args.find((a) => !a.startsWith('-'))
  const unknown = args.find((a) => a.startsWith('-'))
  if (unknown !== undefined) {
    process.stderr.write(`vx upgrade: unknown flag: ${unknown}\n`)
    return 1
  }
  if (!isCompiledBinary()) {
    throw new UserError(
      'vx upgrade only works for the compiled binary (install.sh). ' +
        'You are running from source — use git pull instead.',
    )
  }
  const asset = assetName()
  const url =
    tag === undefined
      ? `https://github.com/${REPO}/releases/latest/download/${asset}`
      : `https://github.com/${REPO}/releases/download/${tag}/${asset}`
  const dest = process.execPath
  process.stdout.write(`vx upgrade: ${VERSION} → ${tag ?? 'latest'} (${dest})\n`)
  await replaceBinary(dest, url)
  // Report the replaced binary's own version — the new build speaks
  // for itself rather than this process guessing.
  const proc = Bun.spawnSync({ cmd: [dest, '--version'], stdout: 'pipe', stderr: 'pipe' })
  const v = new TextDecoder().decode(proc.stdout).trim()
  process.stdout.write(`vx upgrade: installed ${v || '(version check failed)'}\n`)
  return 0
}
