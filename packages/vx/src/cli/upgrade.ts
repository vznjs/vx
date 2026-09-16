// `vx upgrade [tag]` — self-update the compiled binary in place.
// Asks the GitHub release API for the asset of this os/arch and the
// SHA-256 digest it publishes, downloads the asset, verifies the digest,
// writes next to the current executable, atomic rename over it. The
// digest is what makes a cut transfer (a proxy that drops a connection,
// a disk that fills) or a swapped asset a refusal instead of a binary
// that does not start: the rename is the last step, and a mismatch
// replaces nothing.
// Named `upgrade` (not `update`) per CLI convention: bun upgrade,
// deno upgrade — "update" is what package managers do to indexes.

import { chmod, rename, rm } from 'node:fs/promises'
import { seeHelp } from './help.js'
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
 * check silently failed for every installed binary and `vx
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

/** What the release API says about the asset this platform installs. */
export interface ReleaseAsset {
  url: string
  /** Lower-case hex SHA-256 of the asset's bytes. */
  sha256: string
}

/**
 * Pick this platform's asset out of a release document and read the
 * digest the API publishes for it (`sha256:<hex>` on every asset a
 * release built through `release.yml` carries). A release without the
 * asset, or an asset without a digest, is refused here: an upgrade that
 * cannot be verified is not attempted.
 */
export function releaseAsset(release: unknown, name: string): ReleaseAsset {
  const tag =
    typeof release === 'object' &&
    release !== null &&
    typeof (release as { tag_name?: unknown }).tag_name === 'string'
      ? (release as { tag_name: string }).tag_name
      : '(unknown)'
  const assets =
    typeof release === 'object' &&
    release !== null &&
    Array.isArray((release as { assets?: unknown }).assets)
      ? (release as { assets: unknown[] }).assets
      : []
  const asset = assets.find(
    (a): a is { name: string; browser_download_url?: unknown; digest?: unknown } =>
      typeof a === 'object' && a !== null && (a as { name?: unknown }).name === name,
  )
  if (asset === undefined) {
    throw new UserError(`vx upgrade: release ${tag} has no asset ${name} for this platform`)
  }
  const url = asset.browser_download_url
  if (typeof url !== 'string' || url.length === 0) {
    throw new UserError(`vx upgrade: release ${tag} names no download for ${name}`)
  }
  const digest = asset.digest
  const m = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest) : null
  if (m === null) {
    throw new UserError(
      `vx upgrade: release ${tag} publishes no SHA-256 digest for ${name} — nothing to verify the download against, so it is not attempted`,
    )
  }
  return { url, sha256: m[1]!.toLowerCase() }
}

/** The release document for `latest` or a tag, from the GitHub API. */
async function fetchRelease(tag: string | undefined): Promise<unknown> {
  const url =
    tag === undefined
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `vx/${VERSION}` },
  })
  if (!res.ok) {
    throw new UserError(
      `vx upgrade: could not read the release (${res.status}) — ${url}${res.status === 404 && tag !== undefined ? ` (is ${tag} a release tag?)` : ''}`,
    )
  }
  return (await res.json()) as unknown
}

/**
 * Download `url`, verify its SHA-256 against `sha256`, and atomically
 * replace `dest` with it. Exported for tests (which stub `fetch` and
 * point `dest` at a tmp file); the CLI wires it to the release asset
 * and process.execPath.
 */
export async function replaceBinary(dest: string, url: string, sha256: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    throw new UserError(`vx upgrade: download failed (${res.status}) — ${url}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new UserError(`vx upgrade: empty download — ${url}`)
  }
  const got = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  if (got !== sha256.toLowerCase()) {
    throw new UserError(
      `vx upgrade: the download did not match the release's SHA-256 (expected ${sha256}, got ${got}) — nothing replaced; try again, and if it repeats the asset is not the one the release published`,
    )
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
        `check permissions, or reinstall with npm install -g @vzn/vx`,
    )
  }
}

export async function upgradeCmd(args: readonly string[]): Promise<number> {
  const tag = args.find((a) => !a.startsWith('-'))
  const unknown = args.find((a) => a.startsWith('-'))
  if (unknown !== undefined) {
    process.stderr.write(`vx upgrade: unknown flag: ${unknown}${seeHelp('upgrade')}\n`)
    return 1
  }
  if (!isCompiledBinary()) {
    throw new UserError(
      'vx upgrade only works for the compiled binary. ' +
        'You are running from source — use git pull instead. ' +
        '(npm installs update with: npm install -g @vzn/vx@latest)',
    )
  }
  const asset = releaseAsset(await fetchRelease(tag), assetName())
  const dest = process.execPath
  process.stdout.write(`vx upgrade: ${VERSION} → ${tag ?? 'latest'} (${dest})\n`)
  await replaceBinary(dest, asset.url, asset.sha256)
  // Report the replaced binary's own version — the new build speaks
  // for itself rather than this process guessing.
  const proc = Bun.spawnSync({ cmd: [dest, '--version'], stdout: 'pipe', stderr: 'pipe' })
  const v = new TextDecoder().decode(proc.stdout).trim()
  process.stdout.write(`vx upgrade: installed ${v || '(version check failed)'}\n`)
  return 0
}
