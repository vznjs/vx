// The `exec.sandbox.allow` entries that would have granted what a failed
// task was denied, so the report names the line to add (CLI, JSON)
// rather than leaving the user to turn absolute paths into grants. Built on
// the failure path only: a passing run never calls it.

import { lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InputsConfig } from '../config.js'
import { atOrUnder, MOUNT_WILDCARDS, toRealPath, type SandboxViolation } from '../exec/index.js'
import type { TaskOutcome } from '../graph/index.js'
import { isLiteralPattern, relPosix, taskGlobOf } from '../util/index.js'
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
  const raw = grantPath(abs, dirs)
  const wild = raw.search(
    kind === 'write' && process.platform === 'linux' ? MOUNT_WILDCARDS : /[*?]/,
  )
  const bad = Math.min(...[wild, raw.indexOf('\\')].filter((i) => i >= 0))
  const at = bad === Infinity ? raw : raw.slice(0, raw.lastIndexOf('/', bad) + 1) || '.'
  return at.replace(/[[\]]/g, '\\$&')
}

/**
 * A write grant covers the top directory the write landed in: granting
 * `dist/a.js` alone fails the run again on `dist/b.js`. Not when the task
 * reads that directory as an input: the grant would let it write its own
 * inputs, so it names the path alone. Outside the project the top is a
 * `..`, so it names the path alone there too.
 */
function writeGrant(grant: string, isDir: boolean, inputs: readonly string[]): string {
  const slash = grant.indexOf('/')
  const exact = isDir && !grant.endsWith('/') ? `${grant}/` : grant
  if (!inProject(grant) || slash === -1) return exact
  const top = grant.slice(0, slash)
  return inputs.some((g) => readsDir(g, top)) ? exact : `${top}/`
}

/** Whether input glob `g` can match under top directory `top`. */
function readsDir(g: string, top: string): boolean {
  if (g.startsWith('!')) return false
  const first = g.replace(/^\.\//, '').split('/')[0] ?? ''
  return first === top || !isLiteralPattern(first)
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
      if (inProject(rel)) {
        if (!keyed.files(rel)) fix.inputs.add(taskGlobOf(rel))
      } else if (atOrUnder(v.path, dirs.root)) {
        const wsRel = relPosix(dirs.root, v.path)
        if (!keyed.workspaceFiles(wsRel)) fix.workspaceFiles.add(taskGlobOf(wsRel))
      }
    } else if (isPerRunTemp(v.path)) continue
    else if (upstream.some((u) => atOrUnder(v.path!, toRealPath(u)))) continue
    else {
      const isDir =
        v.line.startsWith('mkdir') ||
        lstatSync(v.path, { throwIfNoEntry: false })?.isDirectory() === true
      fix.write.add(writeGrant(grantFor(v.path, dirs, 'write'), isDir, inputs?.files ?? []))
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
