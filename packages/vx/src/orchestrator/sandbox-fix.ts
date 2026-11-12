// The `exec.sandbox.allow` entries that would have granted what a failed
// task was denied, so the report names the line to add (CLI, JSON)
// rather than leaving the user to turn absolute paths into grants. Built on
// the failure path only: a passing run never calls it.

import { lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InputsConfig, TaskOutputs } from '../config.js'
import { atOrUnder, MOUNT_WILDCARDS, toRealPath, type SandboxViolation } from '../exec/index.js'
import type { TaskOutcome } from '../graph/index.js'
import { grantPrefix, isLiteralPattern, relPosix, taskGlobOf } from '../util/index.js'
import { credentialStorePaths } from './sandbox-request.js'

/** Grants to add under `exec.sandbox.allow`, each list sorted and unique. */
type SandboxFix = NonNullable<TaskOutcome['sandboxFix']>
type Kind = Exclude<keyof SandboxFix, 'withheld' | 'inputs' | 'workspaceFiles'>

// A denial in a credential store is never turned into a grant: an agent
// applies `sandboxFix` as given, so a dependency probing ~/.ssh would get
// its grant suggested and applied (Security, 2026-10-12). The stores are
// the ones the sandbox denies: a hand copy here missed half of them.
function isCredential(abs: string): boolean {
  const base = path.basename(abs)
  if (base === '.env' || base.startsWith('.env.')) return true
  return credentialStorePaths(os.homedir()).some((d) => abs === d || abs.startsWith(d + path.sep))
}

/** Where a fix is spelled from: the project's and the workspace root's canonical dirs. */
interface Dirs {
  project: string
  root: string
}

/**
 * A path as a grant names it, unescaped: project-relative inside the
 * workspace (`../a/x.js`: an absolute one holds only on the machine that
 * printed it), `~/…` under home, else absolute.
 */
function grantPath(abs: string, dirs: Dirs): string {
  if (atOrUnder(abs, dirs.root)) return relPosix(dirs.project, abs) || '.'
  const home = os.homedir()
  return abs.startsWith(home + path.sep) ? `~/${abs.slice(home.length + 1)}` : abs
}

/**
 * The grant that allows `abs`, spelled as the sandbox reads it: a bracket
 * escaped, since `pages/[id].tsx` is a class that grants `pages/i.tsx`,
 * and applying the fix failed the run again on the same read. A path no
 * grant can name alone (a `*`, `?` or backslash; on Linux a write with a
 * bracket too: sandbox-binds.ts) is granted as the directory above it.
 */
function grantFor(abs: string, dirs: Dirs, kind: 'read' | 'write'): string {
  return spell(grantPath(abs, dirs), kind)
}

function spell(raw: string, kind: 'read' | 'write'): string {
  const wild = raw.search(
    kind === 'write' && process.platform === 'linux' ? MOUNT_WILDCARDS : /[*?]/,
  )
  const bad = Math.min(...[wild, raw.indexOf('\\')].filter((i) => i >= 0))
  const at = bad === Infinity ? raw : raw.slice(0, raw.lastIndexOf('/', bad) + 1) || '.'
  return at.replace(/[[\]]/g, '\\$&')
}

/**
 * A write grant covers the narrowest directory the next run's writes land
 * in too: granting `dist/a.js` alone fails the run again on `dist/b.js`.
 * That is the deeper of a declared output's directory (`src/generated/`,
 * not `src/`) and, in `node_modules`, the tool's own directory (`.vite/`,
 * `.cache/storybook/`, `.prisma/`): node_modules whole made every
 * installed package writable. Else it is the top directory, and outside
 * the project, where the top is a `..`, the path alone. Not when the task
 * reads that directory as an input: the grant would let it write its own
 * inputs, so it names the path alone.
 */
function writeGrant(
  abs: string,
  dirs: Dirs,
  isDir: boolean,
  inputs: readonly string[],
  outDirs: readonly string[],
): string {
  const raw = grantPath(abs, dirs)
  const exact = spell(isDir && !raw.endsWith('/') ? `${raw}/` : raw, 'write')
  if (!atOrUnder(abs, dirs.root)) return exact
  const parts = raw.split('/')
  const nm = parts.lastIndexOf('node_modules')
  const depths = [
    ...outDirs.filter((d) => `${raw}/`.startsWith(`${d}/`)).map((d) => d.split('/').length),
    nm === -1 ? 0 : nm + (/^(?:\.cache|@.*)$/.test(parts[nm + 1] ?? '') ? 3 : 2),
    inProject(raw) ? 1 : 0,
  ]
  const depth = Math.max(...depths)
  if (depth === 0 || depth >= parts.length) return exact
  const dir = parts.slice(0, depth).join('/')
  const read =
    inProject(dir) && inputs.some((g) => readsDir(g, dir)) && !inputs.some((g) => dropsDir(g, dir))
  return read ? exact : spell(`${dir}/`, 'write')
}

/** The directories a task's declared outputs name, spelled as a grant names a path. */
function outputDirs(outputs: Partial<TaskOutputs> | undefined, dirs: Dirs): string[] {
  const at = (base: string, g: string) => grantPath(path.join(base, grantPrefix(g)), dirs)
  return [
    ...(outputs?.files ?? []).map((g) => at(dirs.project, g)),
    ...(outputs?.workspaceFiles ?? []).map((g) => at(dirs.root, g)),
  ].filter(
    (d) =>
      !path.isAbsolute(d) &&
      !d.startsWith('~/') &&
      d.split('/').some((p) => p !== '..' && p !== '.'),
  )
}

/** Whether input glob `g` can match under directory `dir`. */
function readsDir(g: string, dir: string): boolean {
  if (g.startsWith('!')) return false
  const segs = g.replace(/^\.\//, '').split('/')
  const at = dir.split('/')
  for (let i = 0; i < at.length; i++) {
    const seg = segs[i]
    // The glob ends at or above `dir`: a directory named whole.
    if (seg === undefined) return true
    if (seg === '**') return true
    if (isLiteralPattern(seg) ? seg !== at[i] : !new Bun.Glob(seg).match(at[i]!)) return false
  }
  return true
}

/** Whether input glob `g` is a `!dir/**` that takes back all of `dir`. */
function dropsDir(g: string, dir: string): boolean {
  const head = /^!(?:\.\/)?(.+)\/\*\*(?:\/\*)?$/.exec(g)?.[1]
  return (
    head !== undefined && isLiteralPattern(head) && (dir === head || dir.startsWith(`${head}/`))
  )
}

const inProject = (grant: string): boolean =>
  !grant.startsWith('~/') && !path.isAbsolute(grant) && grant !== '..' && !grant.startsWith('../')

/** Whether a path is one the globs, relative to the same directory, match. */
function keyedBy(globs: readonly string[]): (rel: string) => boolean {
  const strip = (g: string) => g.replace(/^\.\//, '')
  const take = globs.filter((g) => !g.startsWith('!')).map((g) => new Bun.Glob(strip(g)))
  const drop = globs.filter((g) => g.startsWith('!')).map((g) => new Bun.Glob(strip(g.slice(1))))
  return (rel) => take.some((g) => g.match(rel)) && !drop.some((g) => g.match(rel))
}

/** The task proxy's refusals an `allow.network` entry cannot lift (task-proxy.ts). */
const REFUSED_ANYWAY = /\((?:host is on the deny list|malformed host)\)$/

function kindOf(v: SandboxViolation): Kind | undefined {
  const can = v.ignorable ?? []
  if (can.length === 1) return can[0]
  // Linux reports a refused `openat` as either: its flags decide. Judged by
  // the host alone, `cat optional.cfg` of a file it lacks was named a
  // write, and the grant made vx create an empty one.
  if (v.opened !== undefined) return v.opened
  // A probe (`access`) names no flags: a file the host has was hidden from
  // a read; one it lacks was being created.
  if (can.includes('read') && can.includes('write') && v.path !== undefined)
    return lstatSync(v.path, { throwIfNoEntry: false }) !== undefined ? 'read' : 'write'
  return undefined
}

export function sandboxFix(
  violations: readonly SandboxViolation[],
  projectDir: string,
  workspaceRoot: string,
  mask: (text: string) => string = (t) => t,
  /**
   * The task's `inputs`, undefined when it does not cache: a write under
   * `files` is granted exactly, and a read no glob matches is named for
   * the key too, in `files` inside the project and `workspaceFiles`
   * elsewhere in the workspace. A grant alone there let an edit replay
   * the old bytes.
   */
  inputs?: Pick<InputsConfig, 'files' | 'workspaceFiles'>,
  /**
   * The dependencies' declared outputs: a write there is their task's
   * work, never a grant here (`upstreamWritesHint` says what is).
   */
  upstream: readonly string[] = [],
  /** The task's own outputs: a write under one is granted its directory. */
  outputs?: Partial<TaskOutputs>,
  /**
   * The projects nested in this one (absolute): `inputs.files` stops at
   * them, and `vx lock` refuses a glob into one, so a read there is named
   * for `inputs.workspaceFiles`.
   */
  nested: readonly string[] = [],
): SandboxFix | undefined {
  const fix: Record<keyof SandboxFix, Set<string>> = {
    read: new Set(),
    write: new Set(),
    network: new Set(),
    systemInfo: new Set(),
    withheld: new Set(),
    inputs: new Set(),
    workspaceFiles: new Set(),
  }
  // Canonical, as a violation's path is: macOS holds `/var` for `/private/var`.
  const dirs = { project: toRealPath(projectDir), root: toRealPath(workspaceRoot) }
  const outDirs = outputDirs(outputs, dirs)
  let markers: string[] | undefined
  const keyed =
    inputs === undefined
      ? undefined
      : { files: keyedBy(inputs.files), workspaceFiles: keyedBy(inputs.workspaceFiles ?? []) }
  for (const v of violations) {
    if (v.hint === true || v.target === undefined) continue
    const kind = kindOf(v)
    if (kind === undefined) continue
    // A host the deny list holds, or a malformed one, no allow grant admits.
    if (kind === 'network' && REFUSED_ANYWAY.test(v.line)) continue
    if (kind === 'network') fix.network.add(v.target.replace(/:\d+$/, ''))
    else if (kind === 'systemInfo') fix.systemInfo.add(v.target)
    else if (v.path === undefined) continue
    else if (isCredential(v.path)) fix.withheld.add(grantPath(v.path, dirs))
    else if (kind === 'read') {
      const rel = grantPath(v.path, dirs)
      fix.read.add(grantFor(v.path, dirs, 'read'))
      // The link the task opened lies in a directory the sandbox lacks: the
      // target alone stays unreachable, and the fix named it again forever.
      if (v.via !== undefined) fix.read.add(grantFor(v.via, dirs, 'read'))
      if (keyed === undefined) continue
      if (inProject(rel) && !nested.some((d) => atOrUnder(v.path!, toRealPath(d)))) {
        if (!keyed.files(rel)) fix.inputs.add(taskGlobOf(rel))
      } else if (atOrUnder(v.path, dirs.root)) {
        const wsRel = relPosix(dirs.root, v.path)
        if (!keyed.workspaceFiles(wsRel)) fix.workspaceFiles.add(taskGlobOf(wsRel))
      }
    } else if (isPerRunTemp(v.path)) continue
    else if (upstream.some((u) => atOrUnder(v.path!, toRealPath(u)))) continue
    else if (misrooted(v.path, dirs) !== undefined) {
      // No write grant: the files belong where the tool missed its root.
      // What it looked for is the grant (`misrootedWriteHint`).
      markers ??= rootMarkers(dirs)
      for (const m of markers) {
        fix.read.add(grantFor(m, dirs, 'read'))
        const wsRel = relPosix(dirs.root, m)
        if (keyed !== undefined && !keyed.workspaceFiles(wsRel))
          fix.workspaceFiles.add(taskGlobOf(wsRel))
      }
    } else if (isTimeNamed(v.path)) {
      const grant = writeGrant(path.dirname(v.path), dirs, true, inputs?.files ?? [], outDirs)
      fix.write.add(grant === './' ? (timeGlob(path.basename(v.path)) ?? grant) : grant)
    } else {
      const isDir =
        v.line.startsWith('mkdir') ||
        lstatSync(v.path, { throwIfNoEntry: false })?.isDirectory() === true
      fix.write.add(writeGrant(v.path, dirs, isDir, inputs?.files ?? [], outDirs))
    }
  }
  const out: SandboxFix = {}
  for (const k of Object.keys(fix) as (keyof SandboxFix)[])
    if (fix[k].size > 0) out[k] = [...new Set([...fix[k]].map(mask))].sort()
  return Object.keys(out).length > 0 ? out : undefined
}

// `bun build --compile` stages `.<16 hex>-<n>.bun-build` in its cwd, a new
// name each run: a grant naming one failed the next run on another, and a
// Linux grant is a mount, so a glob grant covers no file made later.
const isPerRunTemp = (abs: string): boolean => abs.endsWith('.bun-build')

// A name holding a millisecond clock (13 digits, until 2286) is new each
// run, as vite's `vite.config.ts.timestamp-<ms>-<hex>.mjs`: granted by
// name, the next run failed on the next. Its directory is the grant.
const isTimeNamed = (abs: string): boolean => /(?:^|\D)\d{13}(?:\D|$)/.test(path.basename(abs))

/**
 * A time-named file in the project itself as a glob from its clock on,
 * keeping its extension (`vite.config.ts.timestamp-*.mjs`): its directory,
 * vite 5's config beside `vite.config.ts`, was the whole project. Undefined
 * when the fixed part holds a character a grant cannot name literally.
 */
function timeGlob(base: string): string | undefined {
  const at = /(?:^|\D)(\d{13})(?:\D|$)/.exec(base)
  if (at === null) return undefined
  const start = at.index + at[0].indexOf(at[1]!)
  const ext = path.extname(base)
  const tail = base.length - ext.length >= start + 13 ? ext : ''
  const glob = `${base.slice(0, start)}*${tail}`
  return isLiteralPattern(glob.replace('*', '')) ? glob : undefined
}

/**
 * The note for a write refused at a per-run temp name, which `sandboxFix`
 * grants no path for: the `ignore` glob the docs give (config.ts
 * `SandboxConfig.ignore`), from the project. Undefined when there is none.
 */
export function perRunWriteHint(
  violations: readonly SandboxViolation[],
  projectDir: string,
  workspaceRoot: string,
): SandboxViolation | undefined {
  const dirs = { project: toRealPath(projectDir), root: toRealPath(workspaceRoot) }
  const globs = new Set<string>()
  for (const v of violations)
    if (v.hint !== true && v.path !== undefined && isPerRunTemp(v.path) && kindOf(v) === 'write') {
      const dir = path.posix.dirname(grantPath(v.path, dirs))
      globs.add(dir === '.' ? '*.bun-build' : `${dir}/*.bun-build`)
    }
  if (globs.size === 0) return undefined
  const list = [...globs].sort().map((g) => `'${g.replace(/[\\']/g, '\\$&')}'`)
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: a temp file named anew each run (bun build --compile's) cannot be granted; ` +
      `ignore it instead: \`sandbox: { ignore: { write: [${list.join(', ')}] } }\`.`,
  }
}

/**
 * The files a tool looks up the tree for to find the workspace root: the
 * package managers' lockfiles (Next's tracing root, `findRootDir`). Not
 * `package.json`: every project has its own, so a find-up for it stops in
 * the project.
 */
const ROOT_MARKERS = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]

/**
 * Where a write in the project lands in an installed package's files, or
 * the store holding them, that a directory above the project holds too:
 * the project-relative path of that package (or store) in the directory
 * above. A tool that finds its root by a file it looks up the tree for, and
 * the sandbox hides, takes the project for the root and writes
 * there what belongs above: `next build`'s standalone copy wrote
 * `node_modules/.bun/next@…/…` under the app, and the write grant the fix
 * named gave a green, cached build whose server could not start
 * (2026-11-12). Undefined for any other write.
 */
function misrooted(abs: string, dirs: Dirs): string | undefined {
  if (dirs.project === dirs.root || !atOrUnder(abs, dirs.project)) return undefined
  const parts = relPosix(dirs.project, abs).split('/')
  let end = -1
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'node_modules') continue
    const name = parts[i + 1]!
    if (STORES.has(name)) end = i + 2
    else if (/^[^._]/.test(name)) end = Math.min(parts.length, i + (name.startsWith('@') ? 3 : 2))
    if (end !== -1) break
  }
  if (end === -1) return undefined
  const held = parts.slice(0, end).join('/')
  for (let dir = path.dirname(dirs.project); atOrUnder(dir, dirs.root); dir = path.dirname(dir)) {
    if (lstatSync(path.join(dir, held), { throwIfNoEntry: false }) !== undefined)
      return relPosix(dirs.project, path.join(dir, held))
    if (dir === dirs.root) break
  }
  return undefined
}

/** The package stores under `node_modules`: bun's isolated linker's, pnpm's. */
const STORES = new Set(['.bun', '.pnpm'])

/** The root markers on this machine above the project, up to the workspace root. */
function rootMarkers(dirs: Dirs): string[] {
  const out: string[] = []
  for (let dir = path.dirname(dirs.project); atOrUnder(dir, dirs.root); dir = path.dirname(dir)) {
    for (const m of ROOT_MARKERS) {
      const p = path.join(dir, m)
      if (lstatSync(p, { throwIfNoEntry: false })?.isFile() === true) out.push(p)
    }
    if (dir === dirs.root) break
  }
  return out
}

/**
 * The note for writes `misrooted` names, which `sandboxFix` grants no
 * write for: the tool missed its root, and what it looks for is the
 * grant. Undefined when there is none.
 */
export function misrootedWriteHint(
  violations: readonly SandboxViolation[],
  projectDir: string,
  workspaceRoot: string,
): SandboxViolation | undefined {
  const dirs = { project: toRealPath(projectDir), root: toRealPath(workspaceRoot) }
  const written: string[] = []
  const held = new Set<string>()
  for (const v of violations) {
    if (v.hint === true || v.path === undefined || kindOf(v) !== 'write') continue
    const at = misrooted(v.path, dirs)
    if (at === undefined) continue
    written.push(relPosix(dirs.project, v.path))
    held.add(at)
  }
  if (written.length === 0) return undefined
  const shown = written.slice(0, 3).join(', ')
  const more = written.length > 3 ? ` and ${written.length - 3} more` : ''
  const markers = rootMarkers(dirs).map(
    (m) => `'${grantFor(m, dirs, 'read').replace(/[\\']/g, '\\$&')}'`,
  )
  const said =
    `vx: the task wrote installed packages' files under the project (${shown}${more}), which ` +
    `${[...held].slice(0, 2).join(', ')} holds: it took the project for its root, as a tool ` +
    `does that finds its root by a file the sandbox hides. A write grant there is not the fix`
  return {
    timestamp: new Date(),
    hint: true,
    line:
      markers.length === 0
        ? `${said}; grant a read of the file it looks for above the project.`
        : `${said}; grant what it looks for: \`allow: { read: [${markers.join(', ')}] }\`.`,
  }
}
