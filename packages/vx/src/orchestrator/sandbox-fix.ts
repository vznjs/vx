// The `exec.sandbox.allow` entries that would have granted what a failed
// task was denied, so the report names the line to add (CLI, JSON, MCP)
// rather than leaving the user to turn absolute paths into grants. Built on
// the failure path only: a passing run never calls it.

import { lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SandboxViolation } from '../exec/index.js'
import type { TaskOutcome } from '../graph/index.js'

/** Grants to add under `exec.sandbox.allow`, each list sorted and unique. */
type SandboxFix = NonNullable<TaskOutcome['sandboxFix']>
type Kind = Exclude<keyof SandboxFix, 'withheld'>

// Where credentials live. A denial here is never turned into a grant: an
// agent applies `sandboxFix` as given, so a dependency probing ~/.ssh would
// get its grant suggested and applied (Security, 2026-10-12).
const CREDENTIAL_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.config/gh']
const CREDENTIAL_FILES = ['.netrc', '.npmrc', '.docker/config.json']

function isCredential(abs: string): boolean {
  const base = path.basename(abs)
  if (base === '.env' || base.startsWith('.env.')) return true
  const rel = path.relative(os.homedir(), abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return (
    CREDENTIAL_FILES.includes(rel) ||
    CREDENTIAL_DIRS.some((d) => rel === d || rel.startsWith(d + path.sep))
  )
}

/**
 * A path as a grant spells it: project-relative inside the project, `~/…`
 * under home, else absolute.
 */
function grantPath(abs: string, projectDir: string): string {
  const rel = path.relative(projectDir, abs)
  if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  const home = os.homedir()
  return abs.startsWith(home + path.sep) ? `~/${abs.slice(home.length + 1)}` : abs
}

/**
 * A write grant covers the top directory the write landed in: granting
 * `dist/a.js` alone fails the run again on `dist/b.js`.
 */
function writeGrant(grant: string, isDir: boolean): string {
  const slash = grant.indexOf('/')
  if (grant.startsWith('~/') || path.isAbsolute(grant)) return isDir ? `${grant}/` : grant
  if (slash !== -1) return grant.slice(0, slash + 1)
  return isDir ? `${grant}/` : grant
}

function kindOf(v: SandboxViolation): Kind | undefined {
  const can = v.ignorable ?? []
  if (can.length === 1) return can[0]
  // Linux reports a refused `openat` as either: the flags the parse drops
  // decide. A file the host has was hidden from a read; one it lacks was
  // being created.
  if (can.includes('read') && can.includes('write') && v.path !== undefined)
    return lstatSync(v.path, { throwIfNoEntry: false }) !== undefined ? 'read' : 'write'
  return undefined
}

export function sandboxFix(
  violations: readonly SandboxViolation[],
  projectDir: string,
  mask: (text: string) => string = (t) => t,
): SandboxFix | undefined {
  const fix: Record<Kind | 'withheld', Set<string>> = {
    read: new Set(),
    write: new Set(),
    network: new Set(),
    systemInfo: new Set(),
    withheld: new Set(),
  }
  for (const v of violations) {
    if (v.hint === true || v.target === undefined) continue
    const kind = kindOf(v)
    if (kind === undefined) continue
    if (kind === 'network') fix.network.add(v.target.replace(/:\d+$/, ''))
    else if (kind === 'systemInfo') fix.systemInfo.add(v.target)
    else if (v.path === undefined) continue
    else if (isCredential(v.path)) fix.withheld.add(grantPath(v.path, projectDir))
    else if (kind === 'read') fix.read.add(grantPath(v.path, projectDir))
    else {
      const isDir =
        v.line.startsWith('mkdir') ||
        lstatSync(v.path, { throwIfNoEntry: false })?.isDirectory() === true
      fix.write.add(writeGrant(grantPath(v.path, projectDir), isDir))
    }
  }
  const out: SandboxFix = {}
  for (const k of ['read', 'write', 'network', 'systemInfo', 'withheld'] as const)
    if (fix[k].size > 0) out[k] = [...new Set([...fix[k]].map(mask))].sort()
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The fix as the config line it is: `exec.sandbox.allow: { read: ['a'] }`,
 * or undefined when every denial was a withheld credential path.
 */
export function sandboxFixLine({ withheld: _, ...fix }: SandboxFix): string | undefined {
  if (Object.keys(fix).length === 0) return undefined
  const parts = Object.entries(fix).map(
    ([k, list]: [string, string[]]) => `${k}: [${list.map((p) => `'${p}'`).join(', ')}]`,
  )
  return `exec.sandbox.allow: { ${parts.join(', ')} }`
}
