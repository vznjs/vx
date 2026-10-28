// `vx upgrade [TAG]` — bring this vx to a newer release, the way it was
// installed. A compiled binary installed by hand replaces itself: it reads
// its platform package (`@vzn/vx-<os>-<arch>`) from the npm registry the
// user configured (`resolveRegistry`: .npmrc, bunfig, npmjs.org last),
// checks npm's registry signature over `name@version:integrity` against
// the key pinned below, checks the tarball's SHA-512 against that signed
// integrity, and only then extracts the binary, stages it beside the old
// one and renames it over. The signature is what proves the bytes are the
// ones npm published: the host that serves the tarball cannot mint it
// (pnpm's installer, pnpm/get, checks the same). A vx installed by a
// package manager (npm, pnpm, bun, yarn; global or a project's
// dependency) is upgraded by that package manager, never by a rename over
// a file it owns. vx never installs Node or a package manager.
// Handed a call by a global vx, the project's vx moves that global too,
// to the same version (`upgradeGlobal`).
// Named `upgrade` (not `update`) per CLI convention: bun upgrade,
// deno upgrade — "update" is what package managers do to indexes.

import { constants, existsSync, readFileSync } from 'node:fs'
import { createPublicKey, verify } from 'node:crypto'
import { access, chmod, chown, link, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { flagHint, seeHelp } from './help.js'
import { resolveRegistry, type Registry } from './registry.js'
import { UserError, sayNotice, ui } from '../util/index.js'
import { findWorkspaceRoot } from '../workspace/index.js'
import { VERSION } from '../version.js'

const PACKAGE = '@vzn/vx'

/**
 * npm's registry signing key, from https://registry.npmjs.org/-/npm/v1/keys.
 * Pinned, not fetched: a key read from the registry would prove nothing
 * about the registry's own answers. When npm rotates it, a release of vx
 * carries the new one, and an older vx refuses with that hint.
 */
export const NPM_SIGNING_KEY = {
  id: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
  spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
}

/** A registry key: its id as npm names it, and its SPKI DER, base64. */
export interface SigningKey {
  id: string
  spki: string
}

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
export function isCompiledBinary(): boolean {
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
 * install updates through its package manager (`managedInstall`). Null
 * for a binary installed by hand from a release.
 */
export function npmOwnedBinary(execPath: string): string | null {
  const parts = execPath.split(/[\\/]/)
  const at = parts.lastIndexOf('node_modules')
  if (at === -1) return null
  const scoped = parts[at + 1]?.startsWith('@') === true
  const pkg = parts.slice(at + 1, at + (scoped ? 3 : 2)).join('/')
  return pkg.length > 0 ? pkg : 'node_modules'
}

function platformPackage(): string {
  const os = process.platform
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : null
  if ((os !== 'darwin' && os !== 'linux') || arch === null) {
    throw new UserError(`vx upgrade: unsupported platform ${process.platform}/${process.arch}`)
  }
  return `${PACKAGE}-${os}-${arch}`
}

/** The registry spec for `TAG`: `v0.4.0` and `0.4.0` name a version; none is `latest`. */
export function versionSpec(tag: string | undefined): string {
  if (tag === undefined) return 'latest'
  const v = tag.startsWith('v') ? tag.slice(1) : tag
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) {
    throw new UserError(`vx upgrade: ${tag} is not a version (expected v<major>.<minor>.<patch>)`)
  }
  return v
}

/**
 * `fetch` on a box that cannot reach the host rejects with Bun's own
 * `TypeError` ("Unable to connect. Is the computer able to access the
 * url?", "Was there a typo in the url or port?"), which the CLI printed
 * as an internal error with a stack (a network namespace without a
 * route, 2026-09-16). One line, the host and the reason.
 */
async function fetchOrRefuse(
  url: string,
  init: RequestInit,
  what: string,
  verb = 'vx upgrade',
): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `${verb}: could not reach ${new URL(url).host} to ${what} (${message}) — check the network or the proxy and re-run`,
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
async function readOrRefuse<T>(
  read: () => Promise<T>,
  url: string,
  what: string,
  verb = 'vx upgrade',
): Promise<T> {
  try {
    return await read()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `${verb}: could not ${what} from ${new URL(url).host} (${message}) — nothing replaced; check the network or the proxy and re-run`,
    )
  }
}

/** The registry's document for `pkg@spec` (`latest` or a version). */
export async function fetchManifest(
  pkg: string,
  spec: string,
  verb = 'vx upgrade',
  registry: Registry = resolveRegistry(pkg.split('/')[0]!),
): Promise<unknown> {
  const url = `${registry.url}${pkg}/${spec}`
  const res = await fetchOrRefuse(
    url,
    {
      redirect: 'follow',
      headers: {
        Accept: 'application/json',
        'User-Agent': `vx/${VERSION}`,
        ...authHeader(registry, url),
      },
    },
    'read the release',
    verb,
  )
  if (!res.ok) {
    throw new UserError(
      `${verb}: could not read ${pkg}@${spec} from ${new URL(url).host} (${res.status})${res.status === 404 && spec !== 'latest' ? ` — is ${spec} a published version?` : ''}${res.status === 401 || res.status === 403 ? ' — check the registry credentials in .npmrc or bunfig.toml' : ''}`,
    )
  }
  // A body that is not JSON (a captive portal's page, a proxy's error
  // page served with a 200) is the same refusal as a cut one.
  return await readOrRefuse(() => res.json(), url, 'read the release', verb)
}

function authHeader(registry: Registry, url: string): Record<string, string> {
  const auth = registry.auth(url)
  return auth === undefined ? {} : { Authorization: auth }
}

/** What a verified registry document names: the version, its tarball and the signed integrity. */
export interface SignedRelease {
  version: string
  tarball: string
  integrity: string
}

/**
 * The tarball and integrity of `pkg` in `manifest`, once npm's registry
 * signature over `pkg@version:integrity` verifies against `key`. Every
 * refusal comes before a byte of the tarball is fetched. The message is
 * built from the package vx asked for, so a signature npm made for
 * another package does not verify here.
 */
export function verifiedRelease(
  manifest: unknown,
  pkg: string,
  key: SigningKey = NPM_SIGNING_KEY,
): SignedRelease {
  const m = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as {
    version?: unknown
    dist?: { tarball?: unknown; integrity?: unknown; signatures?: unknown }
  }
  const version = typeof m.version === 'string' ? m.version : ''
  const tarball = m.dist?.tarball
  const integrity = m.dist?.integrity
  if (version === '' || typeof tarball !== 'string' || !tarball.startsWith('https://')) {
    throw new UserError(
      `vx upgrade: the npm registry published no tarball for ${pkg}${version === '' ? '' : `@${version}`} — nothing replaced`,
    )
  }
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(integrity)) {
    throw new UserError(
      `vx upgrade: the npm registry published no SHA-512 integrity for ${pkg}@${version} — nothing to verify the download against, so it is not attempted`,
    )
  }
  const signatures = Array.isArray(m.dist?.signatures)
    ? (m.dist.signatures as unknown[]).filter(
        (s): s is { keyid: string; sig: string } =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as { keyid?: unknown }).keyid === 'string' &&
          typeof (s as { sig?: unknown }).sig === 'string',
      )
    : []
  if (signatures.length === 0) {
    throw new UserError(
      `vx upgrade: ${pkg}@${version} carries no npm registry signature, so it cannot be verified — nothing replaced`,
    )
  }
  const ours = signatures.filter((s) => s.keyid === key.id)
  if (ours.length === 0) {
    throw new UserError(
      `vx upgrade: ${pkg}@${version} is signed with an npm key this vx does not know (${[...new Set(signatures.map((s) => s.keyid))].join(', ')}) — if npm rotated its signing key, this vx's installer needs updating: install the new release with bun add -g @vzn/vx@latest, or from https://github.com/vznjs/vx/releases. Nothing replaced`,
    )
  }
  const publicKey = createPublicKey({
    key: Buffer.from(key.spki, 'base64'),
    format: 'der',
    type: 'spki',
  })
  const message = Buffer.from(`${pkg}@${version}:${integrity}`)
  const valid = ours.some((s) => {
    try {
      return verify('sha256', message, publicKey, Buffer.from(s.sig, 'base64'))
    } catch {
      return false
    }
  })
  if (!valid) {
    throw new UserError(
      `vx upgrade: the npm registry signature for ${pkg}@${version} is not valid — refusing to install; nothing replaced`,
    )
  }
  return { version, tarball, integrity }
}

/** Download `release.tarball` and check its bytes against the signed SHA-512. */
async function downloadVerified(release: SignedRelease, registry: Registry): Promise<Uint8Array> {
  const url = release.tarball
  const res = await fetchOrRefuse(
    url,
    { redirect: 'follow', headers: authHeader(registry, url) },
    'download the release',
  )
  if (!res.ok) {
    throw new UserError(
      `vx upgrade: download failed (${res.status}) — ${url} — nothing replaced; re-run`,
    )
  }
  const bytes = new Uint8Array(
    await readOrRefuse(() => res.arrayBuffer(), url, 'download the release'),
  )
  const got = `sha512-${new Bun.CryptoHasher('sha512').update(bytes).digest('base64')}`
  if (got !== release.integrity) {
    throw new UserError(
      `vx upgrade: the download did not match the integrity npm signed (expected ${release.integrity}, got ${got}) — nothing replaced; try again, and if it repeats the tarball is not the one npm published`,
    )
  }
  return bytes
}

/**
 * The `package/vx` file of a platform package's tarball (gzip'd ustar, as
 * npm packs it). Only a regular file by that name is taken: the tarball is
 * already verified, so this reads, it does not defend.
 */
export function binaryFromTarball(tgz: Uint8Array): Uint8Array {
  let tar: Uint8Array
  try {
    tar = Bun.gunzipSync(tgz as Uint8Array<ArrayBuffer>)
  } catch {
    throw new UserError('vx upgrade: the release tarball is not gzip — nothing replaced')
  }
  const text = (b: Uint8Array): string => new TextDecoder().decode(b).replace(/\0[\s\S]*$/, '')
  for (let at = 0; at + 512 <= tar.length;) {
    const head = tar.subarray(at, at + 512)
    const name = text(head.subarray(0, 100))
    if (name === '') break
    const prefix = text(head.subarray(257, 263)) === 'ustar' ? text(head.subarray(345, 500)) : ''
    const size = Number.parseInt(text(head.subarray(124, 136)).trim() || '0', 8)
    const type = head[156]
    const body = at + 512
    if (
      (prefix === '' ? name : `${prefix}/${name}`) === 'package/vx' &&
      (type === 0x30 || type === 0)
    ) {
      return tar.slice(body, body + size)
    }
    at = body + Math.ceil(size / 512) * 512
  }
  throw new UserError('vx upgrade: the release tarball holds no package/vx — nothing replaced')
}

/**
 * The binary of `pkg@spec`, verified: the registry document's signature,
 * then the tarball's integrity, then the extraction, each refusing before
 * the next step runs. Null when the release is `current`, the version of
 * the vx being replaced; `announce` hears the version before the download
 * starts.
 */
export async function releaseBinary(
  pkg: string,
  spec: string,
  announce: (version: string) => void,
  key: SigningKey = NPM_SIGNING_KEY,
  current = VERSION,
): Promise<Uint8Array | null> {
  const registry = resolveRegistry(pkg.split('/')[0]!)
  const release = verifiedRelease(await fetchManifest(pkg, spec, undefined, registry), pkg, key)
  if (release.version === current) return null
  announce(release.version)
  return binaryFromTarball(await downloadVerified(release, registry))
}

/**
 * Replace `dest` with the bytes `fetchBinary` returns (null: nothing to
 * do, and false is returned), keeping `dest`'s
 * mode (and, as root, its owner): a 0750 install came back 0755 and owned
 * by whoever upgraded (item 1097). Whether this user can write beside
 * `dest` is checked before `fetchBinary` runs, so a refusal downloads
 * nothing. `starts`, when given, is asked of the replaced binary; false
 * puts the old one back, since a verified download proves the bytes, not
 * that this machine can run them (a CPU below the build's target, a
 * `noexec` mount), and the upgrade reported success over a vx that no
 * longer started.
 */
export async function replaceBinary(
  dest: string,
  fetchBinary: () => Promise<Uint8Array | null>,
  starts?: (dest: string) => boolean,
): Promise<boolean> {
  // The swap writes beside the binary: a directory this user cannot write
  // (a root-owned /usr/local/bin) failed at the rename, the whole release
  // downloaded for nothing, and the hint named npm, which this binary is not.
  const dir = path.dirname(dest)
  await access(dir, constants.W_OK).catch((err: NodeJS.ErrnoException) => {
    throw new UserError(
      `vx upgrade: cannot write to ${dir} (${err.code ?? err.message}), where this vx lives — nothing downloaded; re-run as a user who can (sudo vx upgrade), or install vx somewhere you can write`,
    )
  })
  const bytes = await fetchBinary()
  if (bytes === null) return false
  if (bytes.byteLength === 0) {
    throw new UserError(`vx upgrade: the release's binary is empty — nothing replaced`)
  }
  // A fresh directory beside the binary, not a name built from the pid:
  // anyone who can write the install directory could plant a link at a
  // predictable name, and a `sudo vx upgrade` wrote through it as root.
  let stage: string
  try {
    stage = await mkdtemp(path.join(dir, '.vx-upgrade-'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `vx upgrade: could not stage the new binary in ${dir} (${msg}) — nothing replaced; check the permissions of ${dir}`,
    )
  }
  const tmp = path.join(stage, 'new')
  const old = path.join(stage, 'previous')
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
    await rm(stage, { recursive: true, force: true })
    const msg = err instanceof Error ? err.message : String(err)
    throw new UserError(
      `vx upgrade: could not replace ${dest} (${msg}) — nothing replaced; check the permissions of ${dest} and its directory`,
    )
  }
  if (starts === undefined || starts(dest)) {
    await rm(stage, { recursive: true, force: true })
    return true
  }
  if (kept) await rename(old, dest)
  await rm(stage, { recursive: true, force: true })
  throw new UserError(
    `vx upgrade: the new binary did not start on this machine (\`${dest} --version\` failed)${kept ? ' — the previous vx is back in place' : ''}. Nothing else changed; report it with this os/arch`,
  )
}

/** How a package manager installed this vx: who owns it, and where to run the update. */
export interface ManagedInstall {
  manager: 'npm' | 'pnpm' | 'bun' | 'yarn'
  /** `global`: the manager's own global tree; `project`: a dependency of `cwd`'s package.json. */
  scope: 'global' | 'project'
  cwd: string
  /** The project field that lists `@vzn/vx`. */
  field?: 'dependencies' | 'devDependencies' | 'optionalDependencies'
  /** The `@vzn/vx-*` plugins the same package.json lists from the registry, moved with core. */
  plugins?: string[]
}

const FIELDS = ['devDependencies', 'dependencies', 'optionalDependencies'] as const

function readJson(file: string): Record<string, unknown> | null {
  try {
    // A byte-order mark is stripped, as every package manager strips it.
    const v: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The field of `dir`'s package.json that lists `@vzn/vx`, if one does. */
function listingField(dir: string): ManagedInstall['field'] | undefined {
  const pkg = readJson(path.join(dir, 'package.json'))
  return FIELDS.find((f) => {
    const deps = pkg?.[f]
    return typeof deps === 'object' && deps !== null && PACKAGE in deps
  })
}

/** A release's platform binary, which the launcher pulls in itself: no plugin. */
const PLATFORM = /^@vzn\/vx-(?:darwin|linux)-(?:x64|arm64)$/

/**
 * The `@vzn/vx-*` plugins `dir`'s package.json lists from the registry
 * (a `workspace:` or `file:` link is the repo's own). Every @vzn package
 * releases together, so they move with core in its one install
 * (2026-10-16); one in another field would move fields under core's flag,
 * so it is refused.
 */
function pluginsBeside(dir: string, field: NonNullable<ManagedInstall['field']>): string[] {
  const pkg = readJson(path.join(dir, 'package.json'))
  const plugins: string[] = []
  for (const f of FIELDS) {
    const deps = pkg?.[f]
    if (typeof deps !== 'object' || deps === null) continue
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (!name.startsWith(`${PACKAGE}-`) || PLATFORM.test(name)) continue
      if (typeof spec !== 'string' || /^(?:workspace|file|link|portal):/.test(spec)) continue
      if (f !== field) {
        throw new UserError(
          `vx upgrade: ${name} is in ${f} and ${PACKAGE} in ${field}; list them in one field so one install moves them together`,
        )
      }
      plugins.push(name)
    }
  }
  return plugins.sort()
}

/** The version of `pkg` installed where `dir` resolves it, if any. */
function installedVersion(dir: string, pkg: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    const v = readJson(path.join(d, 'node_modules', pkg, 'package.json'))?.['version']
    if (typeof v === 'string') return v
    if (path.dirname(d) === d) return undefined
  }
}

/** The project's package manager: its lockfile, then `packageManager`, then the tree's shape. */
export function projectManager(dir: string, execPath: string): ManagedInstall['manager'] {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, 'pnpm-lock.yaml'))) return 'pnpm'
    if (existsSync(path.join(d, 'bun.lock')) || existsSync(path.join(d, 'bun.lockb'))) return 'bun'
    if (existsSync(path.join(d, 'yarn.lock'))) return 'yarn'
    if (
      existsSync(path.join(d, 'package-lock.json')) ||
      existsSync(path.join(d, 'npm-shrinkwrap.json'))
    )
      return 'npm'
    const declared = readJson(path.join(d, 'package.json'))?.['packageManager']
    if (typeof declared === 'string') {
      const name = declared.split('@')[0]
      if (name === 'pnpm' || name === 'bun' || name === 'yarn' || name === 'npm') return name
    }
    if (path.dirname(d) === d) break
  }
  return execPath.includes(`${path.sep}node_modules${path.sep}.pnpm${path.sep}`) ? 'pnpm' : 'npm'
}

/**
 * How a package manager installed the binary at `execPath`, or null when
 * none did (a release binary installed by hand). The launcher runs the
 * platform package's binary, `…/node_modules/@vzn/vx-<os>-<arch>/vx`, so
 * the path names the tree: a manager's global directory, or a project
 * whose package.json lists `@vzn/vx` (the tree's root, else the nearest
 * one above `cwd`, for a workspace whose dependencies are hoisted). A
 * package-manager cache (npx, bunx) is refused: nothing there to upgrade.
 */
export function managedInstall(execPath: string, cwd: string): ManagedInstall | null {
  const owner = npmOwnedBinary(execPath)
  if (owner === null) return null
  const p = execPath.split(path.sep).join('/')
  const root = p.slice(0, `${p}/`.indexOf('/node_modules/'))
  if (p.includes('/_npx/') || /\/bunx-[^/]*\//.test(p)) {
    throw new UserError(
      `vx upgrade: this vx runs from a package-manager cache (${execPath}) — nothing is installed to upgrade; ask for the version you want instead: bunx @vzn/vx@latest`,
    )
  }
  if (p.includes('/.bun/install/global/')) return { manager: 'bun', scope: 'global', cwd: root }
  if (/\/pnpm\/global\/|\/pnpm-global\//.test(p))
    return { manager: 'pnpm', scope: 'global', cwd: root }
  if (/\/yarn\/global\//.test(p)) return { manager: 'yarn', scope: 'global', cwd: root }
  const field = listingField(root)
  if (field !== undefined) {
    const plugins = pluginsBeside(root, field)
    return { manager: projectManager(root, execPath), scope: 'project', cwd: root, field, plugins }
  }
  for (
    let d = path.resolve(cwd);
    d === root || d.startsWith(`${root}${path.sep}`);
    d = path.dirname(d)
  ) {
    const f = listingField(d)
    if (f !== undefined) {
      const plugins = pluginsBeside(d, f)
      return { manager: projectManager(d, execPath), scope: 'project', cwd: d, field: f, plugins }
    }
    if (path.dirname(d) === d) break
  }
  // npm's global tree: `<prefix>/lib/node_modules` (nvm, volta, Homebrew alike).
  if (path.basename(root) === 'lib' && !existsSync(path.join(root, 'package.json'))) {
    return { manager: 'npm', scope: 'global', cwd: root }
  }
  throw new UserError(
    `vx upgrade: this vx was installed by a package manager (${execPath} belongs to ${owner}), but no package.json from ${cwd} up lists ${PACKAGE} — run the upgrade with the manager that installed it, e.g. npm install -g ${PACKAGE}@latest`,
  )
}

/** The argv that brings `install` to `version`. */
export function upgradeArgv(install: ManagedInstall, version: string): string[] {
  const spec = `${PACKAGE}@${version}`
  const { manager } = install
  if (install.scope === 'global') {
    if (manager === 'yarn') return ['yarn', 'global', 'add', spec]
    return manager === 'npm' ? ['npm', 'install', '-g', spec] : [manager, 'add', '-g', spec]
  }
  const field = install.field ?? 'devDependencies'
  const flag = {
    npm: {
      devDependencies: '--save-dev',
      dependencies: '--save',
      optionalDependencies: '--save-optional',
    },
    pnpm: {
      devDependencies: '--save-dev',
      dependencies: '--save-prod',
      optionalDependencies: '--save-optional',
    },
    bun: { devDependencies: '--dev', dependencies: '', optionalDependencies: '--optional' },
    yarn: { devDependencies: '--dev', dependencies: '', optionalDependencies: '--optional' },
  }[manager][field]
  const specs = [spec, ...(install.plugins ?? []).map((p) => `${p}@${version}`)]
  const argv = manager === 'npm' ? ['npm', 'install', ...specs] : [manager, 'add', ...specs]
  if (flag !== '') argv.push(flag)
  // pnpm refuses an `add` at a workspace's root without saying it means the root.
  if (manager === 'pnpm' && existsSync(path.join(install.cwd, 'pnpm-workspace.yaml')))
    argv.push('--workspace-root')
  return argv
}

/**
 * The version `tag` names, or the registry's latest: read for the "already
 * at" check, and by `vx init`, which always installs the latest release.
 */
export async function targetVersion(tag: string | undefined, verb = 'vx upgrade'): Promise<string> {
  const spec = versionSpec(tag)
  if (spec !== 'latest') return spec
  const v = ((await fetchManifest(PACKAGE, 'latest', verb)) as { version?: unknown } | null)
    ?.version
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) {
    throw new UserError(`${verb}: the npm registry named no latest version of ${PACKAGE}`)
  }
  return v
}

/**
 * Run the package manager that owns a vx at `current` to bring it to
 * `version`; vx never installs one. `step` names the install when a run
 * moves two (`project `, `global `).
 */
export async function upgradeManaged(
  install: ManagedInstall,
  version: string,
  current = VERSION,
  step = '',
): Promise<boolean> {
  const plugins = install.plugins ?? []
  if (version === current && plugins.every((p) => installedVersion(install.cwd, p) === version)) {
    ui.print('out', ui.status('info', 'vx upgrade', `${step}already at ${current}`))
    return false
  }
  const argv = upgradeArgv(install, version)
  // PATH as it is now: `Bun.which` alone reads the one the process started with.
  const bin = Bun.which(argv[0]!, { PATH: process.env['PATH'] ?? '' })
  if (bin === null) {
    throw new UserError(
      `vx upgrade: this vx was installed by ${argv[0]}, which is not on PATH — vx does not install package managers; run it yourself: ${argv.join(' ')} (in ${install.cwd})`,
    )
  }
  ui.print(
    'out',
    ui.status(
      'info',
      'vx upgrade',
      `${step}${version === current ? 'plugins' : current} → ${version}`,
    ),
    ui.text([ui.cmd(argv.join(' ')), ui.dim(` in ${install.cwd}`)]),
  )
  const proc = Bun.spawnSync({
    cmd: [bin, ...argv.slice(1)],
    cwd: install.cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  if (proc.exitCode !== 0) {
    throw new UserError(
      `vx upgrade: ${argv.join(' ')} failed (exit ${proc.exitCode}) — vx changed nothing itself${
        // The install is pinned, so pnpm refuses a release younger than
        // its minimumReleaseAge instead of mixing releases; its words
        // print above, so the way out is named (as vx-migrate does).
        install.manager === 'pnpm'
          ? `; if pnpm refused a version published within its minimumReleaseAge, list ${[PACKAGE, ...plugins].join(', ')} under minimumReleaseAgeExclude in pnpm-workspace.yaml`
          : ''
      }`,
    )
  }
  return true
}

/**
 * Replace the binary at `dest`, at `current`, with the verified release
 * `spec` names (`latest` or a version). `step` as in `upgradeManaged`.
 */
async function upgradeBinary(
  dest: string,
  spec: string,
  current = VERSION,
  step = '',
  key: SigningKey = NPM_SIGNING_KEY,
): Promise<boolean> {
  const pkg = platformPackage()
  let installed: string | undefined
  const replaced = await replaceBinary(
    dest,
    () =>
      releaseBinary(
        pkg,
        spec,
        (version) =>
          ui.print(
            'out',
            ui.status('info', 'vx upgrade', `${step}${current} → ${version}`),
            ui.text(ui.dim(dest)),
          ),
        key,
        current,
      ),
    // The replaced binary's own version: the new build speaks for itself
    // rather than this process guessing, and one that cannot is rolled back.
    (bin) => {
      installed = answeredVersion(bin)
      return installed !== undefined
    },
  )
  ui.print(
    'out',
    replaced
      ? ui.status('ok', 'vx upgrade', `${step}installed ${installed}`)
      : ui.status('info', 'vx upgrade', `${step}already at ${current}`),
  )
  return replaced
}

/** The version `bin --version` answers, without the hand-off note a handed-off run adds. */
function answeredVersion(bin: string): string | undefined {
  return startedVersion(bin)?.split(' ')[1]
}

/**
 * Bring `from`, the global vx that handed this run to the project's own
 * (`VX_HANDED_OFF`), to `version`, the way it was installed: a binary
 * installed by hand is replaced, a package manager's global install is
 * updated by that manager. A refusal names it.
 */
export async function upgradeGlobal(
  from: string,
  version: string,
  key: SigningKey = NPM_SIGNING_KEY,
): Promise<void> {
  await named(`global vx ${from}`, async () => {
    const current = answeredVersion(from)
    if (current === undefined) {
      throw new UserError('vx upgrade: it did not answer `--version`, so it is left as it is')
    }
    if (current === version) {
      ui.print('out', ui.status('info', 'vx upgrade', `global already at ${current}`))
      return
    }
    const install = managedInstall(from, path.dirname(from))
    if (install === null) await upgradeBinary(from, version, current, 'global ', key)
    else await upgradeManaged(install, version, current, 'global ')
  })
}

/**
 * `vx upgrade -g`: bring this vx, the global one, to `version` and nothing
 * else (2026-10-16) — no project's package.json, no plugin. The
 * project's own vx refuses: no global ran.
 */
export async function upgradeOnlyGlobal(
  self: string,
  version: string,
  current = VERSION,
): Promise<void> {
  if (current === version) {
    ui.print('out', ui.status('info', 'vx upgrade', `global already at ${current}`))
    return
  }
  // Read from the binary's own directory, not cwd: a project there is not this install's.
  const install = managedInstall(self, path.dirname(self))
  if (install?.scope === 'project') {
    throw new UserError(
      `vx upgrade -g: no global vx ran — ${self} is the project's own. Install one (bun add -g ${PACKAGE}), or run \`vx upgrade\` to move the project's`,
    )
  }
  if (install === null) await upgradeBinary(self, version, current, 'global ')
  else await upgradeManaged(install, version, current, 'global ')
}

/** `run`, its refusal naming `what` after the verb: a run that moves two installs says which failed. */
async function named<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof UserError)) throw err
    throw new UserError(err.message.replace(/^vx upgrade: /, `vx upgrade: ${what}: `), err.code)
  }
}

export async function upgradeCmd(argv: readonly string[]): Promise<number> {
  const global = argv.some((a) => a === '-g' || a === '--global')
  const args = argv.filter((a) => a !== '-g' && a !== '--global')
  const unknown = args.find((a) => a.startsWith('-'))
  if (unknown !== undefined) {
    sayNotice(
      'error',
      'vx upgrade',
      `unknown flag: ${unknown}${flagHint('upgrade', unknown)}${seeHelp('upgrade')}`,
    )
    return 1
  }
  // One release is installed; a second tag was dropped without a word and
  // the first one went in (`vx upgrade v0.0.22 v0.0.23`).
  const [tag, extra] = args
  if (extra !== undefined) {
    sayNotice('error', 'vx upgrade', `unexpected argument: ${extra}${seeHelp('upgrade')}`)
    return 1
  }
  if (!isCompiledBinary()) {
    throw new UserError(
      'vx upgrade: only the compiled binary upgrades itself; this vx runs from source — use git pull',
    )
  }
  const dest = process.execPath
  const handedOffFrom = process.env['VX_HANDED_OFF']
  if (global) {
    // A launcher from before -g handed the call over: the global is the one that did.
    const version = await targetVersion(tag)
    if (handedOffFrom !== undefined) await upgradeGlobal(handedOffFrom, version)
    else await upgradeOnlyGlobal(dest, version)
    return 0
  }
  const install = managedInstall(dest, process.cwd())
  // A global vx handed this run to the project's own: both move, to one
  // version, the project first (2026-10-15).
  const from = handedOffFrom
  if (from !== undefined) {
    const version = await targetVersion(tag)
    const moved = await named('project vx', () =>
      install === null
        ? upgradeBinary(dest, version, VERSION, 'project ')
        : upgradeManaged(install, version, VERSION, 'project '),
    )
    await upgradeGlobal(from, version)
    if (moved) await relock(newVx(install, dest))
    return 0
  }
  const moved =
    install !== null
      ? await upgradeManaged(install, await targetVersion(tag))
      : await upgradeBinary(dest, versionSpec(tag))
  if (moved) await relock(newVx(install, dest))
  return 0
}

/**
 * The vx an upgrade just installed: the replaced binary, or the tree's
 * `node_modules/.bin/vx` (a manager's store path names the old version).
 * npm's global tree has no `.bin` there; its platform binary keeps its path.
 */
function newVx(install: ManagedInstall | null, dest: string): string {
  if (install === null) return dest
  const bin = path.join(install.cwd, 'node_modules', '.bin', 'vx')
  return existsSync(bin) ? bin : dest
}

/**
 * Lock the workspace with the vx just installed at `bin` (2026-10-18):
 * a release may record the lock differently. `-g` never re-locks. A lock
 * that fails leaves the upgrade done and says what to run.
 */
export async function relock(bin: string, cwd = process.cwd()): Promise<void> {
  const root = await findWorkspaceRoot(cwd).catch(() => null)
  if (root === null) return
  let code: number | null
  try {
    code = Bun.spawnSync({
      cmd: [bin, 'lock'],
      cwd: root,
      stdio: ['inherit', 'inherit', 'inherit'],
    }).exitCode
  } catch {
    code = null
  }
  if (code !== 0) sayNotice('warn', 'vx upgrade', 'vx lock failed: run vx lock')
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
