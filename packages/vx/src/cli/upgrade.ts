// `vx upgrade [tag]` — self-update the compiled binary in place.
// Asks the GitHub release API for the asset of this os/arch and the
// SHA-256 digest it publishes, downloads the asset, verifies the digest,
// writes next to the current executable, atomic rename over it. The
// digest is what makes a cut or corrupted transfer (a proxy that drops a
// connection, a disk that fills) a refusal instead of a binary that does
// not start: the rename is the last step, and a mismatch replaces
// nothing. It guards the TRANSFER only: the digest comes from the same
// release API as the download URL, and GitHub recomputes it when an asset
// is uploaded, so whoever can replace the asset replaces its digest too
// (item 1096). Nothing here verifies who built the binary.
// Named `upgrade` (not `update`) per CLI convention: bun upgrade,
// deno upgrade — "update" is what package managers do to indexes.

import { constants } from 'node:fs'
import { access, chmod, chown, link, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { flagHint, seeHelp } from './help.js'
import { UserError } from '../util/index.js'
import { VERSION } from '../version.js'

const REPO = 'vznjs/vx'

/**
 * A Bun standalone-binary path lives under the bunfs virtual root.
 * Marker: `/$bunfs/...`.
 */
export function isBunfsPath(p: string): boolean {
  return p.startsWith('/$bunfs')
}

/**
 * True when running as a `bun build --compile` binary. Keys off
 * `Bun.main` (and argv[1]), `import.meta.path` only last: with
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

/**
 * The package directory that owns `execPath` when it sits under a
 * `node_modules` — an npm install's platform binary, which the launcher
 * runs as `…/node_modules/@vzn/vx-<os>-<arch>/vx`. That file is npm's:
 * a rename over it upgrades this command until the next `npm install`
 * (or a lockfile-pinned CI checkout) puts the version npm knows back,
 * and `npm ls` never agrees with `vx --version` in between. Such an
 * install updates through npm, and `vx upgrade` says so. Null for a
 * binary installed by hand from a release.
 */
export function npmOwnedBinary(execPath: string): string | null {
  const parts = execPath.split(/[\\/]/)
  const at = parts.lastIndexOf('node_modules')
  if (at === -1) return null
  const scoped = parts[at + 1]?.startsWith('@') === true
  const pkg = parts.slice(at + 1, at + (scoped ? 3 : 2)).join('/')
  return pkg.length > 0 ? pkg : 'node_modules'
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
  /** The release's tag, as the API names it (`v0.4.0`). */
  tag: string
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
    throw new UserError(
      `vx upgrade: release ${tag} has no asset ${name} for this platform — nothing replaced; npm install -g @vzn/vx@latest installs it instead`,
    )
  }
  const url = asset.browser_download_url
  if (typeof url !== 'string' || url.length === 0) {
    throw new UserError(
      `vx upgrade: release ${tag} names no download for ${name} — nothing replaced; npm install -g @vzn/vx@latest installs it instead`,
    )
  }
  const digest = asset.digest
  const m = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest) : null
  if (m === null) {
    throw new UserError(
      `vx upgrade: release ${tag} publishes no SHA-256 digest for ${name} — nothing to verify the download against, so it is not attempted`,
    )
  }
  return { tag, url, sha256: m[1]!.toLowerCase() }
}

/**
 * Whether a release tag names the version this binary is: the upgrade
 * re-downloaded and replaced a binary with itself, printing `X → latest`
 * (item 1098). Tags are `v<version>`; a bare version is accepted too.
 */
export function isThisVersion(tag: string, version: string): boolean {
  return tag === `v${version}` || tag === version
}

/**
 * `fetch` on a box that cannot reach the host rejects with Bun's own
 * `TypeError` ("Unable to connect. Is the computer able to access the
 * url?", "Was there a typo in the url or port?"), which the CLI printed
 * as an internal error with a stack (a network namespace without a
 * route, 2026-09-16). One line, the host and the reason.
 */
async function fetchOrRefuse(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `vx upgrade: could not reach ${new URL(url).host} to ${what} (${message}) — check the network or the proxy and re-run`,
    )
  }
}

/**
 * A response's body, read to the end. The headers can arrive and the
 * connection drop before the body does (a proxy that cuts a transfer):
 * Bun rejects the read with its own `TypeError` (`ECONNRESET`, "The socket
 * connection was closed unexpectedly"), which `fetchOrRefuse` never sees
 * and the CLI printed as an internal error with a stack.
 */
async function readOrRefuse<T>(read: () => Promise<T>, url: string, what: string): Promise<T> {
  try {
    return await read()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `vx upgrade: could not ${what} from ${new URL(url).host} (${message}) — nothing replaced; check the network or the proxy and re-run`,
    )
  }
}

/** The release document for `latest` or a tag, from the GitHub API. */
export async function fetchRelease(tag: string | undefined): Promise<unknown> {
  const url =
    tag === undefined
      ? `https://api.github.com/repos/${REPO}/releases/latest`
      : `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`
  const res = await fetchOrRefuse(
    url,
    {
      redirect: 'follow',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `vx/${VERSION}` },
    },
    'read the release',
  )
  if (!res.ok) {
    // GitHub answers an unauthenticated address past its hourly budget with
    // 403 (or 429) and says so in the headers; "could not read the release
    // (403)" read as a permissions fault (item 1098).
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    const limited =
      (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0'
    throw new UserError(
      limited
        ? `vx upgrade: GitHub's API rate limit for this address is spent${Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : ''} — re-run after that`
        : `vx upgrade: could not read the release (${res.status}) — ${url}${res.status === 404 && tag !== undefined ? ` (is ${tag} a release tag?)` : ''}`,
    )
  }
  // A body that is not JSON (a captive portal's page, a proxy's error
  // page served with a 200) is the same refusal as a cut one.
  return await readOrRefuse(() => res.json() as Promise<unknown>, url, 'read the release')
}

/**
 * Download `url`, verify its SHA-256 against `sha256`, and atomically
 * replace `dest` with it, keeping `dest`'s mode (and, as root, its owner):
 * a 0750 install came back 0755 and owned by whoever upgraded (item 1097).
 * `starts`, when given, is asked of the replaced binary; false puts the old
 * one back, since the digest proves the bytes, not that this machine can
 * run them (a CPU below the build's target, a `noexec` mount), and the
 * upgrade reported success over a vx that no longer started. Exported for
 * tests (which stub `fetch` and point `dest` at a tmp file); the CLI wires
 * it to the release asset and process.execPath.
 */
export async function replaceBinary(
  dest: string,
  url: string,
  sha256: string,
  starts?: (dest: string) => boolean,
): Promise<void> {
  // The swap writes beside the binary: a directory this user cannot write
  // (a root-owned /usr/local/bin) failed at the rename, the whole release
  // downloaded for nothing, and the hint named npm, which this binary is not.
  const dir = path.dirname(dest)
  await access(dir, constants.W_OK).catch((err: NodeJS.ErrnoException) => {
    throw new UserError(
      `vx upgrade: cannot write to ${dir} (${err.code ?? err.message}), where this vx lives — nothing downloaded; re-run as a user who can (sudo vx upgrade), or install vx somewhere you can write`,
    )
  })
  const res = await fetchOrRefuse(url, { redirect: 'follow' }, 'download the release asset')
  if (!res.ok) {
    throw new UserError(
      `vx upgrade: download failed (${res.status}) — ${url} — nothing replaced; re-run`,
    )
  }
  const bytes = new Uint8Array(
    await readOrRefuse(() => res.arrayBuffer(), url, 'download the release asset'),
  )
  if (bytes.byteLength === 0) {
    throw new UserError(`vx upgrade: empty download — ${url} — nothing replaced; re-run`)
  }
  const got = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  if (got !== sha256.toLowerCase()) {
    throw new UserError(
      `vx upgrade: the download did not match the release's SHA-256 (expected ${sha256}, got ${got}) — nothing replaced; try again, and if it repeats the asset is not the one the release published`,
    )
  }
  const tmp = `${dest}.upgrade-${process.pid}`
  const old = `${dest}.previous-${process.pid}`
  let kept = false
  try {
    const was = await stat(dest).catch(() => null)
    await Bun.write(tmp, bytes)
    // Its mode, executable wherever it is readable: a 0750 install stays
    // group-only, and a binary is never left without its execute bits.
    await chmod(tmp, was === null ? 0o755 : (was.mode & 0o7777) | ((was.mode & 0o444) >> 2))
    if (was !== null && process.getuid?.() === 0) await chown(tmp, was.uid, was.gid)
    // A second name for the binary being replaced, so a new one that does
    // not start can be put back; the rename below stays the one atomic swap.
    if (starts !== undefined && was !== null) {
      await link(dest, old)
      kept = true
    }
    await rename(tmp, dest)
  } catch (err) {
    await rm(tmp, { force: true })
    if (kept) await rm(old, { force: true })
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `vx upgrade: could not replace ${dest} (${msg}) — nothing replaced; check the permissions of ${dest} and its directory`,
    )
  }
  if (starts === undefined || starts(dest)) {
    if (kept) await rm(old, { force: true })
    return
  }
  if (kept) await rename(old, dest)
  throw new UserError(
    `vx upgrade: the new binary did not start on this machine (\`${dest} --version\` failed)${kept ? ' — the previous vx is back in place' : ''}. Nothing else changed; report it with this os/arch`,
  )
}

export async function upgradeCmd(args: readonly string[]): Promise<number> {
  const unknown = args.find((a) => a.startsWith('-'))
  if (unknown !== undefined) {
    process.stderr.write(
      `vx upgrade: unknown flag: ${unknown}${flagHint('upgrade', unknown)}${seeHelp('upgrade')}\n`,
    )
    return 1
  }
  // One release is installed; a second tag was dropped without a word and
  // the first one went in (`vx upgrade v0.0.22 v0.0.23`).
  const [tag, extra] = args
  if (extra !== undefined) {
    process.stderr.write(`vx upgrade: unexpected argument: ${extra}${seeHelp('upgrade')}\n`)
    return 1
  }
  if (!isCompiledBinary()) {
    throw new UserError(
      'vx upgrade only works for the compiled binary. ' +
        'You are running from source — use git pull instead. ' +
        '(npm installs update with: npm install -g @vzn/vx@latest)',
    )
  }
  const dest = process.execPath
  const owner = npmOwnedBinary(dest)
  if (owner !== null) {
    throw new UserError(
      `vx upgrade: this vx was installed by npm (${dest} belongs to ${owner}) — npm owns that file, and the next npm install would put the version it knows back. Update with: npm install -g @vzn/vx@latest`,
    )
  }
  const asset = releaseAsset(await fetchRelease(tag), assetName())
  if (isThisVersion(asset.tag, VERSION)) {
    process.stdout.write(`vx upgrade: already at ${VERSION} (${asset.tag}) — nothing to do\n`)
    return 0
  }
  process.stdout.write(`vx upgrade: ${VERSION} → ${tag ?? 'latest'} (${dest})\n`)
  // The replaced binary's own version: the new build speaks for itself
  // rather than this process guessing, and one that cannot is rolled back.
  let installed = ''
  await replaceBinary(dest, asset.url, asset.sha256, (bin) => {
    installed = startedVersion(bin) ?? ''
    return installed !== ''
  })
  process.stdout.write(`vx upgrade: installed ${installed}\n`)
  return 0
}

/**
 * `bin --version` when it answers as vx within `timeoutMs`, else null. The
 * answer decides whether a replaced binary is rolled back, so it is
 * bounded: a binary that hung on start held `vx upgrade` forever, new
 * binary in place, old one never restored.
 */
export function startedVersion(bin: string, timeoutMs = 10_000): string | null {
  const proc = Bun.spawnSync({
    cmd: [bin, '--version'],
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  })
  const out = new TextDecoder().decode(proc.stdout).trim()
  return proc.exitCode === 0 && out.startsWith('vx ') ? out : null
}
