// The `exec.sandbox.allow` entries that would have granted what a failed
// task was denied, so the report names the line to add (CLI, JSON)
// rather than leaving the user to turn absolute paths into grants. Built on
// the failure path only: a passing run never calls it.

import { lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MOUNT_WILDCARDS, type SandboxViolation } from '../exec/index.js'
import type { TaskOutcome } from '../graph/index.js'
import { isLiteralPattern } from '../util/index.js'
import { credentialStorePaths } from './sandbox-request.js'

/** Grants to add under `exec.sandbox.allow`, each list sorted and unique. */
type SandboxFix = NonNullable<TaskOutcome['sandboxFix']>
type Kind = Exclude<keyof SandboxFix, 'withheld' | 'inputs'>

// A denial in a credential store is never turned into a grant: an agent
// applies `sandboxFix` as given, so a dependency probing ~/.ssh would get
// its grant suggested and applied (Security, 2026-10-12). The stores are
// the ones the sandbox denies: a hand copy here missed half of them.
function isCredential(abs: string): boolean {
  const base = path.basename(abs)
  if (base === '.env' || base.startsWith('.env.')) return true
  return credentialStorePaths(os.homedir()).some((d) => abs === d || abs.startsWith(d + path.sep))
}

/**
 * A path as a grant names it, unescaped: project-relative inside the
 * project, `~/…` under home, else absolute.
 */
function grantPath(abs: string, projectDir: string): string {
  const rel = path.relative(projectDir, abs)
  if (rel === '') return '.'
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel
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
function grantFor(abs: string, projectDir: string, kind: 'read' | 'write'): string {
  const raw = grantPath(abs, projectDir)
  const wild = raw.search(
    kind === 'write' && process.platform === 'linux' ? MOUNT_WILDCARDS : /[*?]/,
  )
  const bad = Math.min(...[wild, raw.indexOf('\\')].filter((i) => i >= 0))
  const at = bad === Infinity ? raw : raw.slice(0, raw.lastIndexOf('/', bad) + 1) || '.'
  return at.replace(/[[\]]/g, '\\$&')
}

/** A project path as `inputs.files` names it: each task-glob wildcard escaped. */
const taskGlobOf = (rel: string): string => rel.replace(/[*?{}[\]\\]/g, '\\$&')

/**
 * A write grant covers the top directory the write landed in: granting
 * `dist/a.js` alone fails the run again on `dist/b.js`. Not when the task
 * reads that directory as an input: the grant would let it write its own
 * inputs, so it names the path alone.
 */
function writeGrant(grant: string, isDir: boolean, inputs: readonly string[]): string {
  const slash = grant.indexOf('/')
  const exact = isDir && !grant.endsWith('/') ? `${grant}/` : grant
  if (grant.startsWith('~/') || path.isAbsolute(grant) || slash === -1) return exact
  const top = grant.slice(0, slash)
  return inputs.some((g) => readsDir(g, top)) ? exact : `${top}/`
}

/** Whether input glob `g` can match under top directory `top`. */
function readsDir(g: string, top: string): boolean {
  if (g.startsWith('!')) return false
  const first = g.replace(/^\.\//, '').split('/')[0] ?? ''
  return first === top || !isLiteralPattern(first)
}

const inProject = (grant: string): boolean => !grant.startsWith('~/') && !path.isAbsolute(grant)

/** Whether a project-relative path is one the task's input globs match. */
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
  mask: (text: string) => string = (t) => t,
  /**
   * The task's `inputs.files`, undefined when it does not cache: a
   * write under one is granted exactly, and a read of the project no glob
   * matches is named for the key too.
   */
  inputs?: readonly string[],
): SandboxFix | undefined {
  const fix: Record<Kind | 'withheld' | 'inputs', Set<string>> = {
    read: new Set(),
    write: new Set(),
    network: new Set(),
    systemInfo: new Set(),
    withheld: new Set(),
    inputs: new Set(),
  }
  const keyed = inputs === undefined ? undefined : keyedBy(inputs)
  for (const v of violations) {
    if (v.hint === true || v.target === undefined) continue
    const kind = kindOf(v)
    if (kind === undefined) continue
    // A host the deny list holds, or a malformed one, no allow grant admits.
    if (kind === 'network' && REFUSED_ANYWAY.test(v.line)) continue
    if (kind === 'network') fix.network.add(v.target.replace(/:\d+$/, ''))
    else if (kind === 'systemInfo') fix.systemInfo.add(v.target)
    else if (v.path === undefined) continue
    else if (isCredential(v.path)) fix.withheld.add(grantPath(v.path, projectDir))
    else if (kind === 'read') {
      const rel = grantPath(v.path, projectDir)
      fix.read.add(grantFor(v.path, projectDir, 'read'))
      // The link the task opened lies in a directory the sandbox lacks: the
      // target alone stays unreachable, and the fix named it again forever.
      if (v.via !== undefined) fix.read.add(grantFor(v.via, projectDir, 'read'))
      if (keyed !== undefined && inProject(rel) && !keyed(rel)) fix.inputs.add(taskGlobOf(rel))
    } else {
      const isDir =
        v.line.startsWith('mkdir') ||
        lstatSync(v.path, { throwIfNoEntry: false })?.isDirectory() === true
      fix.write.add(writeGrant(grantFor(v.path, projectDir, 'write'), isDir, inputs ?? []))
    }
  }
  const out: SandboxFix = {}
  for (const k of ['read', 'write', 'network', 'systemInfo', 'withheld', 'inputs'] as const)
    if (fix[k].size > 0) out[k] = [...new Set([...fix[k]].map(mask))].sort()
  return Object.keys(out).length > 0 ? out : undefined
}
