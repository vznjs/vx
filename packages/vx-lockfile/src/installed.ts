// Whether `node_modules` is the install the lockfile names. The key folds
// the lockfile, never the tree, so a run after a `git pull` with no
// install built against the old packages and saved the output under the
// new lockfile's key: every later run, the install done, replayed it.
//
// Each manager leaves a record of what it installed beside the tree (npm
// `node_modules/.package-lock.json`, pnpm `node_modules/.pnpm/lock.yaml`,
// Yarn 1 `node_modules/.yarn-integrity`, Yarn 2+ `node_modules/.yarn-state.yml`,
// or under `nodeLinker: pnpm` its `node_modules/.store`);
// Bun leaves none (1.4.4, either linker), so its workspaces' dependencies
// are read where Node resolves them, and every package where its linker
// put it. The answer is a pure function of the
// files compared, so a match is kept in the cache dir under their stat
// identities (Bun's: each workspace's `node_modules` directory, which a
// relink or a replaced package moves) and a warm run only stats them.
import {
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { UserError } from '@vzn/vx'
import { readUtf8 } from './json.js'

const load = createRequire(import.meta.url)
const bunLock = (): typeof import('./bun.js') => load('./bun.js')
const npmLock = (): typeof import('./npm.js') => load('./npm.js')
const pnpmLock = (): typeof import('./pnpm.js') => load('./pnpm.js')
const yarnLock = (): typeof import('./yarn.js') => load('./yarn.js')

/** What the install left that disagrees with the lockfile; `dirs`: what the kept match stats too. */
interface Verdict {
  readonly mismatch?: string | undefined
  readonly dirs?: readonly string[]
}

interface InstallCheck {
  /** The record the install leaves, root-relative, any one of them; none: Bun. */
  readonly markers?: readonly string[]
  readonly compare: (
    lock: string,
    parse: (text: string) => unknown,
    marker: { file: string; text: string } | undefined,
    root: string,
  ) => Verdict
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}

/**
 * npm's hidden lockfile: each installed path's version. A path the lockfile
 * leaves out, or one it names at another version, is another install; one
 * it names that the tree lacks too, when the install should have it: a
 * production dependency of a package or workspace the tree holds, or of
 * the root once every workspace is installed (`-w` installs neither the
 * other workspaces nor the root's own; `--omit=dev`, a platform's optional
 * package).
 */
function npmCompare(lockText: string, markerText: string, root: string): string | undefined {
  const lock = obj(obj(JSON.parse(lockText))['packages'])
  const tree = obj(obj(JSON.parse(markerText))['packages'])
  // The record is not the tree: `npm install --dry-run` (npm 10.9) rewrites
  // it to the new lockfile and installs nothing.
  for (const [p, raw] of Object.entries(tree)) {
    const version = obj(raw)['version']
    if (!p.includes('node_modules/') || typeof version !== 'string') continue
    const installed = versionAt(root, p)
    if (installed !== version) {
      return `${p} is ${installed === undefined ? 'not installed' : String(installed)}, node_modules/.package-lock.json names ${String(version)}`
    }
  }
  for (const [p, raw] of Object.entries(tree)) {
    const want = lock[p]
    if (want === undefined) return `${p} is installed, and the lockfile does not list it`
    const [w, t] = [obj(want), obj(raw)]
    // The version, or a link's target: a mirror rewrites `resolved` alone.
    if (
      w['version'] !== t['version'] ||
      (w['version'] === undefined && w['resolved'] !== t['resolved'])
    ) {
      return `${p} is ${String(t['version'] ?? t['resolved'])}, the lockfile names ${String(w['version'] ?? w['resolved'])}`
    }
  }
  const keys = { packages: new Set(Object.keys(lock)) }
  const workspaces = Object.values(lock)
    .map((e) => obj(e))
    .filter((e) => e['link'] === true && typeof e['resolved'] === 'string')
    .map((e) => e['resolved'] as string)
    .filter((t) => t in lock)
  const from = Object.keys(tree).filter((p) => obj(tree[p])['link'] !== true)
  if (workspaces.every((w) => w in tree)) from.push('')
  for (const p of from) {
    for (const name of Object.keys(obj(obj(lock[p])['dependencies']))) {
      const at = npmLock().resolve(keys, p, name)
      if (at === undefined || at in tree) continue
      const e = obj(lock[at])
      if (e['dev'] === true || e['optional'] === true || e['devOptional'] === true) continue
      return `${at} is not installed`
    }
  }
  return undefined
}

/**
 * pnpm's current lockfile (`node_modules/.pnpm/lock.yaml`): what each
 * importer it installed links, and every package it installed. A filtered
 * or `--prod` install records less, so only a disagreement, an extra
 * package an importer reaches or a missing production dependency counts.
 */
function pnpmCompare(want: import('./pnpm.js').Lockfile, markerText: string): string | undefined {
  const tree = pnpmLock().parseLockfile(markerText)
  for (const [importer, deps] of tree.importers) {
    const wanted = want.importers.get(importer)
    if (wanted === undefined) continue
    for (const [name, version] of deps) {
      const w = wanted.get(name)
      if (w === undefined)
        return `${importer}'s ${name} is installed, and the lockfile does not list it`
      if (w !== version) return `${importer}'s ${name} is ${version}, the lockfile names ${w}`
    }
    const prod = new Set(
      (want.sections.get(importer) ?? '')
        .split('\n')
        .filter((l) => l.startsWith('dependencies\0'))
        .map((l) => l.slice('dependencies\0'.length)),
    )
    for (const name of prod) {
      if (!deps.has(name)) return `${importer}'s ${name} ${wanted.get(name)} is not installed`
    }
  }
  // Only what an importer reaches: `pnpm add`, `update` and `remove` keep
  // the package they replaced in the record until a plain `pnpm install`.
  const seen = new Set<string>()
  const queue = [...tree.importers.values()]
  for (let deps = queue.pop(); deps !== undefined; deps = queue.pop()) {
    for (const [name, version] of deps) {
      const key = pnpmLock().snapshotKey(tree, name, version)
      const reached = tree.snapshots.get(key)
      if (reached === undefined || seen.has(key)) continue
      if (!want.snapshots.has(key)) return `${key} is installed, and the lockfile does not list it`
      seen.add(key)
      queue.push(reached)
    }
  }
  return undefined
}

/**
 * Yarn 1's integrity file: each entry it installed and from where. An
 * entry the lockfile lists elsewhere or not at all counts, and so does one
 * it lists that the file lacks, unless the install recorded a flag that
 * leaves entries out (`--production`: every dev entry; `--focus`).
 */
function yarnClassicCompare(
  lock: import('./yarn.js').Lockfile,
  markerText: string,
): string | undefined {
  const record = obj(JSON.parse(markerText))
  const tree = obj(record['lockfileEntries'])
  const resolved = (d: string): string =>
    lock.entries.get(lock.descriptors.get(d)!)!.resolution.split('\0')[1]!
  for (const [d, url] of Object.entries(tree)) {
    if (!lock.descriptors.has(d)) return `${d} is installed, and the lockfile does not list it`
    if (resolved(d) !== url)
      return `${d} is installed from ${String(url)}, the lockfile names ${resolved(d)}`
  }
  const flags = record['flags']
  if (
    !Array.isArray(flags) ||
    flags.some((f) => f === 'production' || String(f).startsWith('focus'))
  ) {
    return undefined
  }
  for (const d of lock.descriptors.keys()) {
    if (!(d in tree)) return `${d} is not installed`
  }
  return undefined
}

/**
 * Yarn 2+'s node_modules state: the packages it installed by locator. A
 * locator the lockfile does not resolve to is another install; a missing
 * one may be a platform's optional package, so only the extra counts.
 * Then each workspace the state lists (a focused install lists only
 * those it installed): its registry dependencies where Node resolves
 * them. A pull that moves a workspace to a version another package
 * already holds leaves no extra locator, only the old copy where the
 * workspace loads it.
 */
function yarnBerryCompare(
  lock: import('./yarn.js').Lockfile,
  markerText: string,
  root: string,
): string | undefined {
  const listed = new Set<string>()
  for (const line of markerText.split('\n')) {
    const m = /^"?([^\s"].*?)"?:$/.exec(line)
    if (m === null || m[1] === '__metadata') continue
    // A virtual locator is its package's, per peer set.
    const locator = m[1]!.replace(/@virtual:[^#]+#/, '@')
    if (!lock.entries.has(locator))
      return `${locator} is installed, and the lockfile does not list it`
    listed.add(locator)
  }
  let rc: string | undefined
  try {
    rc = readUtf8(path.join(root, yarnLock().YARNRC))
  } catch {
    // None: no catalog to read.
  }
  const direct = yarnLock().directVersions(lock, yarnLock().catalogsOf(rc))
  for (const [dir, id] of lock.workspaces) {
    if (!listed.has(id)) continue
    for (const [name, version] of direct.get(dir)!) {
      for (let d = dir; ; d = path.posix.dirname(d)) {
        const installed = versionAt(
          root,
          d === '.' ? `node_modules/${name}` : `${d}/node_modules/${name}`,
        )
        if (installed !== undefined) {
          if (installed !== version)
            return `${dir}'s ${name} is ${installed}, the lockfile names ${version}`
          break
        }
        if (d === '.') break
      }
    }
  }
  return undefined
}

/**
 * Yarn 2+'s `nodeLinker: pnpm` store, which writes no .yarn-state.yml: one
 * directory per locator, its name ending in the first 10 hex of the
 * locator's hash (Yarn's `slugifyLocator`). One no lockfile entry hashes
 * to is another install's; a peer set's copy (`-virtual-`) names none.
 */
function yarnStoreCompare(lock: import('./yarn.js').Lockfile, root: string): string | undefined {
  const sha = (s: string): string => new Bun.CryptoHasher('sha512').update(s).digest('hex')
  const hashes = new Set<string>()
  for (const locator of lock.entries.keys()) {
    const at = locator.indexOf('@', 1)
    const ident = locator.slice(0, at)
    const slash = ident.startsWith('@') ? ident.indexOf('/') : -1
    const identHash =
      slash === -1 ? sha(ident) : sha(ident.slice(1, slash) + ident.slice(slash + 1))
    hashes.add(sha(identHash + locator.slice(at + 1)).slice(0, 10))
  }
  for (const dir of readdirSync(path.join(root, 'node_modules', '.store'))) {
    const m = /-([0-9a-f]{10})$/.exec(dir)
    if (m === null || dir.endsWith(`-virtual-${m[1]}`) || hashes.has(m[1]!)) continue
    return `node_modules/.store/${dir} is installed, and the lockfile does not list it`
  }
  return undefined
}

/** The version of the package installed at root-relative `dir`; none when absent or unreadable. */
function versionAt(root: string, dir: string): string | undefined {
  let text: string
  try {
    text = readUtf8(path.join(root, dir, 'package.json'))
  } catch {
    return undefined
  }
  // A registry package has a top-level version, so a sole `"version":` is
  // it: parsing every manifest was half a cold check (10 of 20 ms, 630 packages).
  const keys = text.match(VERSION_KEY)
  if (keys?.length === 1) return clean(/"version"\s*:\s*"([^"\\]*)"/.exec(text)?.[1])
  let version: unknown
  try {
    version = obj(JSON.parse(text))['version']
  } catch {
    return undefined
  }
  return typeof version === 'string' ? clean(version) : undefined
}

/**
 * A manifest version as npm cleans it on publish and every lockfile records
 * it: typebot's @upstash/redis ships `"version": "v1.35.3"`, which bun.lock
 * names 1.35.3, and the check refused every run as another install.
 */
const clean = (v: string | undefined): string | undefined => v?.trim().replace(/^[=v]+/, '')
const VERSION_KEY = /"version"\s*:/g

/**
 * Each workspace's registry dependencies where Node resolves them: its own
 * `node_modules`, then each one up to the root. One the tree lacks fails
 * the task that loads it; one at another version is the stale install.
 * Then every package the lockfile lists, where the linker put it: a pull
 * that bumps only a transitive version moves no workspace's dependency.
 */
function bunCompare(lock: import('./bun.js').Lockfile, root: string): Verdict {
  const dirs = ['node_modules']
  const read = new Map<string, string | undefined>()
  const at = (dir: string): string | undefined => {
    if (!read.has(dir)) read.set(dir, versionAt(root, dir))
    return read.get(dir)
  }
  for (const [importer, deps] of bunLock().directVersions(lock)) {
    const chain: string[] = []
    for (let d = importer; ; d = path.posix.dirname(d)) {
      chain.push(d === '.' ? 'node_modules' : `${d}/node_modules`)
      if (d === '.') break
    }
    if (importer !== '.') dirs.push(chain[0]!)
    for (const [name, version] of deps) {
      for (const nm of chain) {
        const installed = at(`${nm}/${name}`)
        if (installed === undefined) continue
        if (installed !== version) {
          return {
            mismatch: `${importer}'s ${name} is ${String(installed)}, the lockfile names ${version}`,
          }
        }
        break
      }
    }
  }
  // Only the isolated linker leaves a store; the hoisted one removes it.
  const store = path.join(root, 'node_modules', '.bun')
  if (statSync(store, { throwIfNoEntry: false }) !== undefined) {
    return { mismatch: storeCompare(lock, root, store), dirs }
  }
  for (const [dir, version] of bunLock().hoistedVersions(lock)) {
    const installed = at(dir)
    // Absent: an optional package of another platform, or a `--production` install.
    if (installed !== undefined && installed !== version) {
      return {
        mismatch: `${dir.replaceAll('node_modules/', '')} is ${String(installed)}, the lockfile names ${version}`,
      }
    }
  }
  return { dirs }
}

/** A store entry's package id: `@s+x@1.0.0+<peer hash>` → `@s/x@1.0.0`. */
const storeId = (entry: string): string =>
  (entry.startsWith('@') ? entry.replace('+', '/') : entry).replace(/\+[0-9a-f]{16}$/, '')

/**
 * The isolated linker's store (`node_modules/.bun/<id>/node_modules`), as
 * Node walks it from the workspaces' links: each copy's dependency links to
 * the copy the lockfile resolves. Bun never prunes the store, so a copy no
 * link reaches (an old version, a peer variant gone) is left unread.
 */
function storeCompare(
  lock: import('./bun.js').Lockfile,
  root: string,
  store: string,
): string | undefined {
  const wanted = bunLock().storeLinks(lock)
  const prefix = `${store}/`
  const seen = new Set<string>()
  const queue: string[] = []
  /** Each link in `dir` into the store: its name and the entry it reaches. */
  const links = (dir: string): [string, string][] => {
    const out: [string, string][] = []
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.name.startsWith('@') && e.isDirectory()) {
        for (const [n, to] of links(path.join(dir, e.name))) out.push([`${e.name}/${n}`, to])
        continue
      }
      if (!e.isSymbolicLink()) continue
      const to = path.resolve(dir, readlinkSync(path.join(dir, e.name)))
      if (to.startsWith(prefix))
        out.push([e.name, to.slice(prefix.length, to.indexOf('/', prefix.length))])
    }
    return out
  }
  const visit = (entry: string): void => {
    if (seen.has(entry)) return
    seen.add(entry)
    queue.push(entry)
  }
  for (const dir of lock.workspaces.keys()) {
    for (const [, to] of links(path.join(root, dir, 'node_modules'))) visit(to)
  }
  for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
    const deps = wanted.get(storeId(entry))
    for (const [name, to] of links(path.join(store, entry, 'node_modules'))) {
      const ids = deps?.get(name)
      if (ids !== undefined && !ids.has(storeId(to))) {
        const version = (id: string): string => id.slice(id.indexOf('@', 1) + 1)
        return `${storeId(entry)}'s ${name} is ${version(storeId(to))}, the lockfile names ${[...ids].map(version).join(' or ')}`
      }
      visit(to)
    }
  }
  return undefined
}

const INSTALL_CHECKS: Readonly<Record<string, InstallCheck>> = {
  npm: {
    markers: ['node_modules/.package-lock.json'],
    // Its record compares raw entries: the lockfile's own JSON, not the parse.
    compare: (lock, _parse, marker, root) => ({ mismatch: npmCompare(lock, marker!.text, root) }),
  },
  pnpm: {
    markers: ['node_modules/.pnpm/lock.yaml'],
    compare: (lock, parse, marker) => ({
      mismatch: pnpmCompare(parse(lock) as import('./pnpm.js').Lockfile, marker!.text),
    }),
  },
  yarn: {
    markers: [
      'node_modules/.yarn-integrity',
      'node_modules/.yarn-state.yml',
      'node_modules/.store',
    ],
    compare: (lock, parse, marker, root) => {
      const parsed = parse(lock) as import('./yarn.js').Lockfile
      return {
        mismatch: marker!.file.endsWith('.yarn-integrity')
          ? yarnClassicCompare(parsed, marker!.text)
          : marker!.file.endsWith('.store')
            ? yarnStoreCompare(parsed, root)
            : yarnBerryCompare(parsed, marker!.text, root),
      }
    },
  },
  bun: {
    compare: (lock, parse, _marker, root) =>
      bunCompare(parse(lock) as import('./bun.js').Lockfile, root),
  },
}

/** A file's stat identity; `-` when absent. */
function identity(file: string): { id: string; mtime: number } {
  const st = statSync(file, { bigint: true, throwIfNoEntry: false })
  return st === undefined
    ? { id: '-', mtime: 0 }
    : { id: `${st.ino}:${st.size}:${st.mtimeNs}`, mtime: Number(st.mtimeMs) }
}

/**
 * Refuses the run when `node_modules` is not the install `lockFile` names.
 * Not checked: no `node_modules` (nothing installed is wrong; a task that
 * needs a package fails, and a failure saves nothing), or a manager's
 * record absent (Yarn PnP, an install by another tool). `version`: the
 * check's own, so a changed check asks again. `parse`: the lockfile's
 * parser, memoised with the claim's, so a run whose claim parsed this text
 * (a changed lockfile) does not parse it again.
 */
export function checkInstalled(
  manager: string,
  root: string,
  cacheDir: string,
  lockFile: string,
  version: number,
  parse: (text: string) => unknown,
): void {
  const check = INSTALL_CHECKS[manager]!
  if (statSync(path.join(root, 'node_modules'), { throwIfNoEntry: false }) === undefined) return
  const marker = check.markers?.find((m) => statSync(path.join(root, m), { throwIfNoEntry: false }))
  if (check.markers !== undefined && marker === undefined) return
  // Beside cache.db, as vx-migrate keeps its Nx graph: machine-local, and
  // per root, since a cache dir may be shared.
  const stampFile = path.join(
    cacheDir,
    `vx-lockfile-installed-${manager}-${Bun.hash.xxHash3(root).toString(16)}.json`,
  )
  const sigOf = (dirs: readonly string[]): { sig: string; newest: number } => {
    const ids = [lockFile, ...(marker === undefined ? [] : [marker]), ...dirs].map((f) =>
      identity(path.join(root, f)),
    )
    return {
      sig: [version, ...ids.map((i) => i.id)].join('\0'),
      newest: Math.max(...ids.map((i) => i.mtime)),
    }
  }
  let stamp: { sig: string; dirs: string[] } | undefined
  try {
    stamp = JSON.parse(readFileSync(stampFile, 'utf8'))
  } catch {
    // None kept yet, or unreadable: compare.
  }
  if (Array.isArray(stamp?.dirs) && sigOf(stamp.dirs).sig === stamp.sig) return
  const started = Date.now()
  let verdict: Verdict
  try {
    verdict = check.compare(
      readUtf8(path.join(root, lockFile)),
      parse,
      marker === undefined
        ? undefined
        : // The store is a directory: its compare lists it.
          {
            file: marker,
            text: marker.endsWith('.store') ? '' : readUtf8(path.join(root, marker)),
          },
      root,
    )
  } catch (err) {
    // The lockfile's own refusal comes from its parse; this is the record's.
    throw new UserError(
      `${marker ?? lockFile}: cannot be read (${err instanceof Error ? err.message : String(err)}) — run \`${manager} install\``,
    )
  }
  if (verdict.mismatch !== undefined) {
    throw new UserError(
      `node_modules was installed from a different ${lockFile} (${verdict.mismatch}) — run \`${manager} install\``,
    )
  }
  const dirs = [...(verdict.dirs ?? [])]
  const { sig, newest } = sigOf(dirs)
  // A file written within the timestamp's granularity of the compare may
  // have changed after it under the same identity (racy git): not kept.
  if (newest > started - 1000) return
  try {
    const tmp = `${stampFile}.${process.pid}`
    writeFileSync(tmp, JSON.stringify({ sig, dirs }))
    renameSync(tmp, stampFile)
  } catch {
    // Not kept: the next run compares again.
  }
}
