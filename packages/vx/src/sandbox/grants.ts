// A task's `sandbox` block as the runtime takes it: every path resolved
// and canonical (`resolveSandboxConfig`), globs expanded to what they
// match, and the baselines in the same canonical form.

import path from 'node:path'
import os from 'node:os'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import type { SandboxConfig } from '../config.js'
import type { ResolvedSandboxConfig } from '../exec/index.js'
import { BUN_GLOB_WILDCARDS, grantPrefix, notify, scannable, UserError } from '../util/index.js'
import { scratchWrites } from './binds.js'
import {
  atOrUnder,
  grantAlternatives,
  isMountableLiteral,
  wildcardAt,
  namedPath,
  toRealPath,
} from './paths.js'
import type { SandboxedRunArgs } from './runtime.js'
import { wallsGlobsReach } from './seatbelt.js'
import { jsString } from './hints.js'

/**
 * Canonical form of every path the sandbox policy is expressed in.
 *
 * `resolveSandboxConfig` already canonicalizes the USER's paths; the
 * orchestrator-supplied baselines (the `node_modules` reads and the
 * workspace-root deny anchor) arrived raw, so a workspace reached through a
 * symlink expressed HALF its policy in real paths and half in link paths.
 * bwrap then died mounting the link path inside its new root
 * (`Can't mount tmpfs on /newroot/<link>`) and EVERY sandboxed task failed —
 * whatever the config, with an error naming an internal path the user has no
 * way to act on. Canonicalizing here is what makes the two halves agree.
 */
export interface CanonicalBaselines {
  allowRead: string[]
  denyRead: string[]
  cwd: string
}

/**
 * Linux: each baseline read that is itself a link (a `node_modules` linked
 * out of the workspace), as `[text, at]` for `withPunchedLinks`, when no
 * other read already shows the place it sits. SRT binds the target alone,
 * so with its directory hidden the link was gone and `node_modules/.bin`
 * on the task's PATH led nowhere.
 */
export function baselineLinks(
  baseAllowRead: readonly string[],
  allowRead: readonly string[],
): Array<readonly [string, string]> {
  if (process.platform !== 'linux') return []
  const out: Array<readonly [string, string]> = []
  for (const at of baseAllowRead) {
    let text: string
    try {
      text = readlinkSync(at)
    } catch {
      continue
    }
    const shown = allowRead.some((r) => r !== toRealPath(at) && atOrUnder(at, r))
    if (!shown) out.push([text, at])
  }
  return out
}

/**
 * Linux: each link a read grant is spelled through, as `[text, at]` for
 * `withPunchedLinks`, unless a bound grant above it already shows it.
 * SRT binds a read grant at the path it resolves to, so with
 * `read: ['src/']` over `src -> lib` the task read `lib` and met ENOENT
 * at `src/a.txt`, the spelling it was granted (2026-11-23).
 */
export function readGrantLinks(
  linked: ResolvedSandboxConfig['linkedReads'],
  bound: readonly string[],
): Array<readonly [string, string]> {
  if (process.platform !== 'linux' || linked === undefined) return []
  return linked
    .filter(({ at }) => !bound.some((b) => b !== at && atOrUnder(at, b)))
    .map(({ at, text }) => [text, at] as const)
}

/**
 * Linux: the links the dependencies' output reads are spelled through in
 * the workspace (`out -> real` under `out/**`), hop by hop, for
 * `readGrantLinks`. SRT binds a read at the path it resolves to, and the
 * link lay in the walled project, so the dependant met ENOENT at the
 * outputs it depends on. Only the directories are walked: a file that is
 * a link is never bound alone (`outputBinds`).
 */
export function dependencyReadLinks(
  reads: readonly string[],
  workspaceRoot: string,
): Array<{ at: string; text: string }> {
  if (process.platform !== 'linux' || reads.length === 0) return []
  const out: Array<{ at: string; text: string }> = []
  const seen = new Set<string>()
  for (const read of reads) {
    const rel = path.relative(workspaceRoot, path.dirname(read))
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
    let at = workspaceRoot
    for (const part of rel.split(path.sep)) {
      at = path.join(at, part)
      if (seen.has(at)) continue
      seen.add(at)
      if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() !== true) continue
      for (const l of readLinkSpellings(path.relative(workspaceRoot, at), workspaceRoot, false))
        if (!out.some((o) => o.at === l.at)) out.push(l)
    }
  }
  return out
}

/**
 * Linux: the links a read grant passes through, hop by hop (`src -> lib2
 * -> lib` is both), each at its real spelling: those inside the project,
 * those of a relative grant leaving it inside the workspace (`../sh/` over
 * a root `sh -> sh-real`: the workspace is walled too), and under
 * `hermetic` those outside it too, where the host's root is
 * hidden and a grant of `/usr/bin/python3 -> python3.12` bound the target
 * alone, so the program the task ran was not there.
 */
function readLinkSpellings(
  grant: string,
  projectDir: string,
  hermetic: boolean,
  root = projectDir,
): Array<{ at: string; text: string }> {
  if (process.platform !== 'linux') return []
  const outside = grant.startsWith('~') || path.isAbsolute(grant)
  if (outside && !hermetic) return []
  const full = grant.startsWith('~')
    ? path.join(os.homedir(), grant.slice(1))
    : path.resolve(projectDir, grant)
  // A pattern's links are those of its literal head (`src/*.ts`: `src`).
  const at = wildcardAt(full)
  const lexical = at === -1 ? full : path.dirname(`${full.slice(0, at)}x`)
  const anchor = outside
    ? undefined
    : [projectDir, root].find((d) => atOrUnder(lexical, d))
  const inside = anchor !== undefined
  if (!outside && !inside) return []
  const home = toRealPath(anchor ?? projectDir)
  const out: Array<{ at: string; text: string }> = []
  let cur = inside ? home : path.sep
  let parts = (inside ? path.relative(anchor, lexical) : lexical)
    .split(path.sep)
    .filter(Boolean)
  for (let hops = 0; parts.length > 0;) {
    const next = path.join(cur, parts.shift()!)
    let link = false
    try {
      link = lstatSync(next).isSymbolicLink()
    } catch {
      return out
    }
    if (!link) {
      cur = next
      continue
    }
    if (++hops > 40) return out
    const text = readlinkSync(next)
    // A link at the root (`/lib -> usr/lib`) is left as it is by the
    // hermetic deny, so it is there already.
    if (
      (inside
        ? atOrUnder(next, home)
        : !atOrUnder(next, home) && path.dirname(next) !== path.sep) &&
      !out.some((o) => o.at === next)
    )
      out.push({ at: next, text })
    parts = [...path.resolve(cur, text).split(path.sep).filter(Boolean), ...parts]
    cur = path.sep
  }
  return out
}

export function canonicalBaselines(
  args: Pick<SandboxedRunArgs, 'baseAllowRead' | 'baseDenyRead' | 'cwd'>,
): CanonicalBaselines {
  return {
    allowRead: args.baseAllowRead.map(toRealPath),
    denyRead: args.baseDenyRead.map(toRealPath),
    cwd: toRealPath(args.cwd),
  }
}

/**
 * Linux: does some mount hold the task's cwd? bwrap enters the old cwd
 * only if it exists in the new root, and otherwise `$HOME`, with no word:
 * a project granted no read ran in the home directory, where `cat x.txt`
 * read `~/x.txt`. A grant at or above the cwd holds it, and so does an
 * existing one below (bwrap builds the path to a bind). When none does,
 * the cwd is denied instead: an empty directory the task enters, whose
 * reads are refused and reported as the anchor's are. A single-package
 * workspace's cwd is its anchor, denied already; the runtime takes the
 * second entry as the same mount.
 */
export function cwdMounted(
  cwd: string,
  fs: {
    allowRead?: readonly string[] | undefined
    allowWrite?: readonly string[] | undefined
  },
): boolean {
  return [...(fs.allowRead ?? []), ...(fs.allowWrite ?? [])].some(
    (p) => atOrUnder(cwd, p) || (atOrUnder(p, cwd) && existsSync(p)),
  )
}

/**
 * A write grant that names a path in the project must BIND one there. The
 * grant was realpath'd, so `out.txt -> ../b/src/x` (committed, or planted
 * by the task's own previous run) bound project b's directory writable,
 * and the task wrote into a sibling with exit 0 (item 1003). A read grant
 * may resolve out through a link (`node_modules` into the store) and is
 * not judged here; a grant spelled outside the project is the user's own.
 */
function assertWriteStaysHome(grant: string, real: string, projectDir: string): void {
  if (grant.startsWith('~') || path.isAbsolute(grant)) return
  const lexical = path.resolve(projectDir, grant)
  if (!atOrUnder(lexical, projectDir)) return
  const home = toRealPath(projectDir)
  // `toRealPath` stops at a DANGLING link and keeps its own path, which is
  // inside; the link's target is where a write through it would land.
  const target = throughLinks(real)
  if (atOrUnder(real, home) && atOrUnder(target, home)) return
  throw new UserError(
    `exec.sandbox.allow.write: "${grant}" resolves through a symlink to ${atOrUnder(real, home) ? target : real}, outside the ` +
      `project — a write grant binds the path it names in the project, and vx does not follow a ` +
      `link out of it. Remove the link, or grant the target by its own path.`,
  )
}

/**
 * Linux: a literal write grant spelled through a link in the project
 * (`gen/` over `gen -> real`), as the task names it: the project's real
 * directory with the grant's own components, links unresolved. The grant
 * binds at its real path and bwrap mounts no link, so without a second
 * bind there the task met "Directory nonexistent", or, under a read
 * grant of the project, the link bound read-only over the same directory
 * ("Read-only file system"). Seatbelt judges the resolved path, so macOS
 * needs none.
 */
function linkSpelling(
  grant: string,
  real: string,
  projectDir: string,
  root = projectDir,
): { link: string; target: string } | undefined {
  if (process.platform !== 'linux' || grant.startsWith('~') || path.isAbsolute(grant)) return
  // `gen/**` is the directory whole (`expandGrants`).
  const whole = /\/\*\*(?:\/\*)?$/
  const lexical = path.resolve(projectDir, grant.replace(whole, ''))
  const target = real.replace(whole, '')
  // A relative grant leaving the project is spelled from the workspace,
  // walled the same way (`../gen/` over a root `gen -> gen-real`).
  const base = [projectDir, root].find((d) => atOrUnder(lexical, d))
  if (base === undefined || !isMountableLiteral(target)) return
  const link = path.join(toRealPath(base), path.relative(base, lexical))
  return link === target ? undefined : { link, target }
}

/** Where `p` lands through every link on it, a dangling last one included. */
function throughLinks(p: string, hops = 0): string {
  if (hops > 40) return p
  try {
    return realpathSync(p)
  } catch {
    try {
      return throughLinks(path.resolve(path.dirname(p), readlinkSync(p)), hops + 1)
    } catch {
      const parent = path.dirname(p)
      return parent === p ? p : path.join(throughLinks(parent, hops + 1), path.basename(p))
    }
  }
}

/**
 * Convert a user-facing `SandboxConfig` (paths may be relative / tilde)
 * into a `ResolvedSandboxConfig` (all paths absolute + canonical) for a
 * given project. Relative paths resolve against `projectDir`; tilde
 * paths expand against the user's home; symlinks resolve to real paths.
 */
export function resolveSandboxConfig(
  cfg: SandboxConfig,
  projectDir: string,
  /** Canonical directories a glob's hits stop at (sandbox/request.ts `wallOff`). */
  walls: readonly string[] = [],
  /** The workspace root: a relative grant leaving the project is spelled from it. */
  root = projectDir,
): ResolvedSandboxConfig {
  const resolve = (p: string): string => {
    if (p.startsWith('~')) return toRealPath(path.join(os.homedir(), p.slice(1)))
    if (path.isAbsolute(p)) return toRealPath(p)
    return toRealPath(path.resolve(projectDir, p))
  }
  const a = cfg.allow ?? {}
  const pending: string[] = []
  const globs: string[] = []
  const linked: Array<{ link: string; target: string }> = []
  const linkedReads: Array<{ at: string; text: string }> = []
  const r: ResolvedSandboxConfig = {
    allowRead: expandGrants(
      (a.read ?? []).flatMap(grantAlternatives).map((p) => {
        for (const l of readLinkSpellings(p, projectDir, cfg.hermetic === true, root))
          if (!linkedReads.some((o) => o.at === l.at)) linkedReads.push(l)
        return resolve(p)
      }),
      walls,
    ),
    allowWrite: expandGrants(
      (a.write ?? []).flatMap(grantAlternatives).map((p) => {
        const real = resolve(p)
        assertWriteStaysHome(p, real, projectDir)
        const link = linkSpelling(p, real, projectDir, root)
        if (link !== undefined) linked.push(link)
        // A directory a write glob matches is writable whole, as Linux's
        // bind of the hit makes it: `<glob>/**` collapses below into the
        // glob and its subtree. SRT compiles a glob as an exact regex, so
        // `/tmp/pnpm-store-operation-locks-*/` covered the directory and
        // not the lock file pnpm 12 opens inside it.
        return process.platform !== 'linux' &&
          !isMountableLiteral(real) &&
          !/\/\*\*(?:\/\*)?$/.test(real)
          ? `${real}/**`
          : real
      }),
      walls,
      pending,
      globs,
    ),
  }
  if (pending.length > 0) r.pendingWrites = pending
  if (globs.length > 0) r.writeGlobs = globs
  if (linked.length > 0) r.linkedWrites = linked
  if (linkedReads.length > 0) r.linkedReads = linkedReads
  if (process.platform === 'darwin') {
    const read = wallsGlobsReach(r.allowRead, walls)
    const write = wallsGlobsReach(r.allowWrite, walls)
    if (read.length + write.length > 0) r.wallsReached = { read, write }
  }
  if (a.network !== undefined) r.network = a.network
  if (cfg.deny?.network !== undefined) r.denyNetwork = cfg.deny.network
  if (a.systemInfo !== undefined) r.systemInfo = a.systemInfo
  if (a.unixSockets !== undefined) r.unixSockets = a.unixSockets
  if (a.localBinding !== undefined) r.localBinding = a.localBinding
  if (a.machLookup !== undefined) r.machLookup = a.machLookup
  if (a.pty !== undefined) r.pty = a.pty
  if (a.gitConfig !== undefined) r.gitConfig = a.gitConfig
  if (cfg.weakerWhenNested !== undefined) r.weakerWhenNested = cfg.weakerWhenNested
  if (cfg.weakerNetworkIsolation !== undefined) {
    r.weakerNetworkIsolation = cfg.weakerNetworkIsolation
  }
  if (cfg.hermetic === true) r.hermetic = true
  if (cfg.ignore !== undefined) {
    // Relative patterns anchor at the project dir, `~` ones at the home
    // directory, as a grant's are (a `~` pattern kept as written matched no
    // recorded path). A pattern is not a path, but its literal head is: both
    // producers record where a denial LANDS, so the head is canonicalized
    // like every other side of the policy. Anchored at a project reached
    // through a link (macOS's `/var`), no pattern matched and the denial it
    // named failed the task (B-2).
    const anchor = (pat: string): string => {
      const abs = pat.startsWith('~')
        ? path.join(os.homedir(), pat.slice(1))
        : path.isAbsolute(pat)
          ? pat
          : path.join(projectDir, pat)
      const wild = abs.search(BUN_GLOB_WILDCARDS)
      const head = wild === -1 ? abs : abs.slice(0, abs.lastIndexOf(path.sep, wild)) || path.sep
      return toRealPath(head) + abs.slice(head.length)
    }
    r.ignore = {
      ...(cfg.ignore.read ? { read: cfg.ignore.read.map(anchor) } : {}),
      ...(cfg.ignore.write ? { write: cfg.ignore.write.map(anchor) } : {}),
      ...(cfg.ignore.systemInfo ? { systemInfo: [...cfg.ignore.systemInfo] } : {}),
      ...(cfg.ignore.network ? { network: [...(cfg.ignore.network as string[])] } : {}),
    }
  }
  return r
}

/**
 * Grant paths, with globs handled per platform.
 *
 * macOS: SRT's own `pathFilter` turns a glob into `(regex …)` and a literal
 * into `(subpath …)`, so a pattern is passed through and seatbelt matches
 * it — including files created DURING the run.
 *
 * Linux: a grant is a bwrap bind mount, and you cannot mount a pattern.
 * The glob is expanded against the filesystem here, which means it covers
 * what exists when the task STARTS. A write glob's directory is bound too
 * where a read grant shows it, or in the task's own directory where a
 * tracer runs (`punchedWriteGlobs`), so a match the task creates lands;
 * elsewhere a pattern matching a file the task creates later grants
 * nothing there. Measured before that bind, one task per spelling, each
 * writing files it declares:
 *
 *   write: ['g/**']         ok — collapsed to the directory
 *   write: ['g/a.txt']      ok — a literal is widened to its directory
 *   write: ['g/*']          FAILED: `bash: g/a.txt: Read-only file system`
 *   write: ['g/*.txt']      FAILED, same
 *   write: ['g/?.txt']      FAILED, same
 *   write: ['g/[ab].txt']   FAILED, same
 *
 * The failure names neither vx nor the grant, so `writeGrantMatchedNothing`
 * below says what happened and what to write instead. A READ grant that
 * matches nothing is ordinary (an optional file, a cache not yet
 * populated), so only writes are reported.
 *
 * The classifier is `isMountableLiteral` (sandbox/paths.ts), deliberately
 * NOT `isLiteralPattern`: its docblock says why the brace is not a wildcard
 * to a grant.
 */
function expandGrants(
  paths: readonly string[],
  walls: readonly string[],
  /** Write globs only: where a pattern that matched nothing is put. */
  unmatched?: string[],
  /** Write globs only: where every pattern is put, matched or not. */
  patterns?: string[],
): string[] {
  // A pattern covering a directory WHOLE is that directory. `<d>/**/*` and
  // `<d>/**` match everything UNDER `<d>` and never `<d>` itself, so a task
  // granted `read: ['**/*']` still could not list its own cwd — the exact
  // shape `bun test` and `oxlint` need. Collapsing is not a widening: the
  // pattern already covered every file there; it adds the directory entry.
  //
  // On macOS a `<d>` that is itself a glob keeps its subtree as `<d>/**/*`:
  // SRT matches a glob as an exact regex and a literal as a subpath, so the
  // collapsed `.*.tmp` alone covered the directory and nothing in it, and
  // `bun build --compile` could create its extraction directory but not
  // the runtime inside it (2026-09-29). Not `<d>/**`: SRT strips a trailing
  // `/**` before it compiles the regex (`removeTrailingGlobSuffix`), which
  // CI's `cp: .a1.tmp/f: Operation not permitted` showed.
  const collapsed = paths.flatMap((p) => {
    const m = /^(.*?)\/\*\*(?:\/\*)?$/.exec(p)
    if (m === null) return [p]
    const dir = m[1]!
    return process.platform !== 'linux' && !isMountableLiteral(dir) ? [dir, `${dir}/**/*`] : [dir]
  })
  if (process.platform !== 'linux') return collapsed
  const out: string[] = []
  for (const p of collapsed) {
    if (isMountableLiteral(p)) {
      out.push(p)
      continue
    }
    patterns?.push(p)
    // Anchor the scan at the longest literal prefix so a pattern does not
    // walk the whole filesystem to find its matches.
    const base = path.dirname(p.slice(0, wildcardAt(p)))
    const pattern = path.relative(base, p)
    // A hit that leaves the scan's base through a link is not what the
    // pattern named: bwrap binds by the link's target, so `read: ['*']`
    // over `shared -> ../b/src` bound project b readable, a read `'.'`
    // never gives, and a cached task replayed b's old bytes (item 1006).
    // The boundary is the directory holding the first wildcard component,
    // not the scan's anchor: that sits one component higher.
    const head = p.slice(0, wildcardAt(p))
    const home = toRealPath(head.endsWith('/') ? head.slice(0, -1) : path.dirname(head))
    let hits = 0
    for (const hit of scanOrNothing(pattern, base)) {
      const abs = path.join(base, hit)
      const real = toRealPath(abs)
      if (!atOrUnder(real, home)) continue
      // A hit that IS a wall, or lies inside one, was matched, not named:
      // `read: ['*']` in a root project bound `.git` and `.vx`, and
      // `packages/*` a nested project its key excludes (B-1). A grant that
      // names a wall literally never reaches this loop and stays, and one
      // spelled with escaped brackets names it as surely.
      if (namedPath(p) === undefined && walls.some((w) => atOrUnder(real, w))) continue
      // A write hit that HOLDS a wall would bind it writable: `.*` in a root
      // project matched `.vx`, which holds the cache. A read hit is punched
      // around it instead (`punchWalls`).
      if (
        unmatched !== undefined &&
        namedPath(p) === undefined &&
        walls.some((w) => atOrUnder(w, real))
      )
        continue
      out.push(abs)
      hits++
    }
    if (hits === 0) unmatched?.push(p)
  }
  return out
}

/**
 * A glob's hits under `base`, or none when `base` does not exist yet:
 * `Bun.Glob` throws ENOENT there, and a cache not yet populated on a fresh
 * runner (`~/.cache/x/y/*`) failed its task with the raw errno and no word
 * of the grant (B-6). A missing base matches nothing, as an empty one does.
 */
function scanOrNothing(pattern: string, base: string): Iterable<string> {
  const glob = new Bun.Glob(scannable(pattern))
  try {
    // Materialised here: the throw comes from the first step, not the call.
    return [...glob.scanSync({ cwd: base, onlyFiles: false, dot: true })]
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
}

/**
 * The write globs that matched nothing at the start (Linux): the ones a
 * write may still land under, in the sandbox's scratch, returned; the ones
 * a read-only mount or the host's root holds, reported once each
 * (`writeGrantMatchedNothing`). `anchors` are the deny anchors the scratch
 * is made of; `within`, the task's directory, which the report spells from.
 */
export function pendingWriteGrants(
  config: Pick<ResolvedSandboxConfig, 'pendingWrites'>,
  fs: {
    readonly allowRead?: readonly string[] | undefined
    readonly allowWrite?: readonly string[] | undefined
  },
  anchors: readonly string[],
  within: string,
): string[] {
  const { scratch, mountless } = scratchWrites(config.pendingWrites ?? [], fs, anchors)
  for (const grant of mountless) writeGrantMatchedNothing(grant, within)
  return scratch
}

/** Grants already reported — once per process, not per spawn. */
const warnedEmptyWriteGrant = new Set<string>()

/**
 * A write grant that mounted nothing, said once, before the task dies on
 * it. The remedy is the directory, which is what the grant would have been
 * widened to anyway had it named a file — and it is named with
 * `grantPrefix`, the shared wildcard-free head, NOT the scan's anchor
 * above: that anchor is one component higher (`dirname` of the head, so
 * the relative pattern keeps its wildcard component), and printing it
 * would tell the user to grant the PARENT of the directory they meant.
 */
function writeGrantMatchedNothing(grant: string, within: string): void {
  if (warnedEmptyWriteGrant.has(grant)) return
  warnedEmptyWriteGrant.add(grant)
  // As a committed config spells them (B-97): the absolute path held only
  // on the machine that printed it, as in `outsideWritesHint`.
  const dir = grantSpelled(grantPrefix(grant), within)
  notify({
    kind: 'line',
    tone: 'warn',
    text:
      `[vx] sandbox: the write grant ${jsString(grantSpelled(grant, within))} matches nothing ` +
      `yet, and a read grant mounts its directory read-only, so a file the task creates under ` +
      `it will fail with "Read-only file system". A bind mount covers what exists when the ` +
      `task starts — grant the directory instead: ` +
      `\`allow: { write: [${jsString(dir === '.' ? '.' : `${dir}/`)}] }\`\n`,
  })
}

/** An absolute grant path as a config spells it: from `within`, from `~`, or whole. */
function grantSpelled(p: string, within: string): string {
  const real = toRealPath(within)
  if (atOrUnder(p, real)) return path.relative(real, p) || '.'
  const home = toRealPath(os.homedir())
  return atOrUnder(p, home) ? `~${p.slice(home.length)}` : p
}
