// Write grants as bwrap can honour them, and the SRT custom config built
// from the resolved policy: a file-shaped grant widened to its directory,
// a read grant punched around the write grants inside it, the network
// lists SRT insists on receiving in full.

import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import path from 'node:path'
import {
  atOrUnder,
  isMountableLiteral,
  localBindingOn,
  namedHead,
  wildcardAt,
  toRealPath,
  unique,
} from './paths.js'
import { notify } from '../util/index.js'
import { shellQuote } from '../exec/index.js'
import type { ResolvedSandboxConfig } from '../exec/index.js'
import type { SandboxedRunArgs } from './runtime.js'

type SrtModule = typeof import('@anthropic-ai/sandbox-runtime')
type SrtTaskConfig = NonNullable<Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2]>

/**
 * SRT's per-task config as vx builds it: every path a plain string. SRT
 * also takes `{ path, literal: true }`; vx spells literals itself.
 */
export type TaskSandboxConfig = Omit<SrtTaskConfig, 'filesystem'> & {
  filesystem?: {
    denyRead: string[]
    allowRead?: string[]
    allowWrite: string[]
    denyWrite: string[]
    allowGitConfig?: boolean
  }
}

/**
 * Write grants as bwrap can actually honour them.
 *
 * A grant naming a FILE becomes a bwrap file bind, and you cannot rename
 * onto an active mount point: any tool that writes its output by staging
 * beside it and renaming — `bun build --compile`, most compilers, every
 * atomic writer — dies with EBUSY. Minimal repro, 2026-09-05: under
 * `bwrap --bind /w/dist/out.bin /w/dist/out.bin`, `mv /w/s /w/dist/out.bin`
 * is "Device or resource busy"; binding `/w/dist` instead succeeds.
 *
 * So on Linux a file-shaped grant is widened to its directory. That IS a
 * widening — the task may write its siblings, and read them unrefused
 * (`widenedEntries` has those reads reported) — and it is the narrowest
 * grant the mechanism can express: the alternative is a declared output
 * the task cannot produce. macOS needs none of this (seatbelt matches
 * paths, it does not mount), so the grant stays exact there.
 */
export function bindableWrites(paths: readonly string[]): string[] {
  if (process.platform !== 'linux') return [...paths]
  return unique(paths.filter((p) => !holdsGlobChar(p)).map(bindOf))
}

/**
 * Linux: each write grant spelled through a link in the project, as the
 * bind that puts it where the task names it: `[source, at]`, the grant's
 * own bind and its twin under the link. A file grant binds its directory,
 * so its twin is the link's; a link that is the file itself sits in the
 * bound directory already and needs none. SRT skips a write path that is
 * a sibling link (it reads one as leaving its tree), so vx lays these
 * itself (`withLinkedWrites`).
 */
export function linkedWriteBinds(
  linked: ResolvedSandboxConfig['linkedWrites'],
): Array<readonly [string, string]> {
  if (process.platform !== 'linux' || linked === undefined) return []
  const out: Array<readonly [string, string]> = []
  for (const { link, target } of linked) {
    if (holdsGlobChar(target) || holdsGlobChar(link)) continue
    const source = bindOf(target)
    const at = source === target ? link : path.dirname(link)
    if (at !== source && !out.some(([, a]) => a === at)) out.push([source, at])
  }
  return out
}

/**
 * Linux: SRT's bwrap line with each `linkedWriteBinds` pair bound last,
 * before the `--` that ends bwrap's options: after the masks and the read
 * grants, so none lands over it. The link's directory is then a mount of
 * its target, writable as the grant is.
 */
export function withLinkedWrites(
  wrapped: string,
  binds: ReadonlyArray<readonly [string, string]>,
): string {
  if (binds.length === 0) return wrapped
  for (const m of wrapped.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g)) {
    if (m[0] !== '--') continue
    const words = binds.map(([s, a]) => `--bind ${shellQuote(s)} ${shellQuote(a)} `).join('')
    return `${wrapped.slice(0, m.index)}${words}${wrapped.slice(m.index)}`
  }
  return wrapped
}

/**
 * Linux: the links `punchWritePaths` handed over as read grants, taken out
 * of `allowRead` and returned as `[text, at]`, each laid by vx as the link
 * it is (`withPunchedLinks`). SRT binds a read path by what it resolves
 * to, so a link there was a plain directory inside the sandbox. A grant
 * the punch did not make (in `granted`) is left as it is.
 */
export function punchedLinks(
  granted: readonly string[],
  allowRead: string[],
): Array<readonly [string, string]> {
  if (process.platform !== 'linux') return []
  const whole = new Set(granted)
  const out: Array<readonly [string, string]> = []
  for (let i = allowRead.length - 1; i >= 0; i--) {
    const at = allowRead[i]!
    if (whole.has(at)) continue
    let text: string
    try {
      text = readlinkSync(at)
    } catch {
      // Not a link: a bind.
      continue
    }
    out.push([text, at])
    allowRead.splice(i, 1)
  }
  return out
}

/**
 * Linux: SRT's bwrap line with each `punchedLinks` pair laid as a link,
 * before the `--` that ends bwrap's options and before the masks'
 * read-only remount (`readOnlyMasks`), which would refuse it.
 */
export function withPunchedLinks(
  wrapped: string,
  links: ReadonlyArray<readonly [string, string]>,
): string {
  if (links.length === 0) return wrapped
  for (const m of wrapped.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g)) {
    if (m[0] !== '--') continue
    const words = links.map(([t, a]) => `--symlink ${shellQuote(t)} ${shellQuote(a)} `).join('')
    return `${wrapped.slice(0, m.index)}${words}${wrapped.slice(m.index)}`
  }
  return wrapped
}

/**
 * Linux: the denied cwd made inside the tmpfs that hides it. bwrap enters
 * the old cwd only if it exists in the new root, else `$HOME`, with no
 * word; SRT (0.0.81) lays no mount at a deny an ancestor's tmpfs already
 * hides, so the cwd vx denies under the workspace root's mask was gone and
 * `pwd` read `$HOME`. `--dir` comes after the masks and before their
 * read-only remount, so the task enters an empty, read-only directory.
 */
export function withCwd(wrapped: string, cwd: string | undefined): string {
  if (cwd === undefined) return wrapped
  for (const m of wrapped.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g)) {
    if (m[0] !== '--') continue
    return `${wrapped.slice(0, m.index)}--dir ${shellQuote(cwd)} ${wrapped.slice(m.index)}`
  }
  return wrapped
}

function bindOf(p: string): string {
  if (!isMountableLiteral(p)) return p
  try {
    if (statSync(p).isDirectory()) return p
  } catch {
    // Does not exist yet: `prepareOutputsForBind` creates a file for a
    // file-shaped grant, so treat it as one.
  }
  return path.dirname(p)
}

/**
 * What each directory `bindableWrites` widened a file grant to held when
 * the task started, by real path. A read there is never refused, so the
 * strace pass reports one of these no grant covers: a task granted
 * `write: ['out.txt']` read the whole project unreported, and a cached run
 * replayed an undeclared file's old bytes. What the task creates there is
 * its own, not an input, so only these entries count. Empty off Linux.
 */
export function widenedEntries(paths: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (process.platform !== 'linux') return out
  for (const p of paths) {
    if (holdsGlobChar(p) || bindOf(p) === p) continue
    const dir = toRealPath(path.dirname(p))
    if (out.has(dir)) continue
    try {
      out.set(dir, new Set(readdirSync(dir).map((e) => path.join(dir, e))))
    } catch {
      // Gone or unreadable: nothing there to read.
    }
  }
  return out
}

/**
 * The write globs that matched nothing when the task started, split by
 * where the task's writes under them go. A glob no mount holds is not
 * lost: a path in the workspace that no read or write bind covers is the
 * deny anchor's scratch, and a task may create, write and remove there —
 * nothing it leaves outlives the sandbox. That is a tool's temp directory:
 * `bun build --compile` extracts a cross-compile runtime into
 * `<cwd>/.<hash>-00000000.tmp/` and renames it into its cache, and no
 * bind could name that directory before it existed (2026-09-29). Where a
 * read grant mounts the glob's directory read-only, or it lies outside the
 * workspace, a write under it fails (`mountless`, warned before the task).
 */
export function scratchWrites(
  pending: readonly string[],
  fs: {
    readonly allowRead?: readonly string[] | undefined
    readonly allowWrite?: readonly string[] | undefined
  },
  anchors: readonly string[],
): { scratch: string[]; mountless: string[] } {
  const binds = [...(fs.allowRead ?? []), ...(fs.allowWrite ?? [])]
  const scratch: string[] = []
  const mountless: string[] = []
  for (const glob of pending) {
    const dir = globDir(glob)
    // A write bind holds it: what the task writes there lands.
    if ((fs.allowWrite ?? []).some((w) => atOrUnder(dir, w))) continue
    const free = anchors.some((a) => atOrUnder(dir, a)) && !binds.some((b) => atOrUnder(dir, b))
    ;(free ? scratch : mountless).push(glob)
  }
  return { scratch, mountless }
}

/** The directory a write glob's matches land in: its head's. */
export const globDir = (glob: string): string => path.dirname(glob.slice(0, wildcardAt(glob) + 1))

/**
 * Linux: the directories of the write globs (`dir` → its globs) that a
 * declared read grant shows and no write bind holds. A bind covers what
 * exists when the task starts, so `dist/*.js` bound only the matches
 * already there, and a build writing a new one met `Read-only file system`;
 * and `read: ['.']` beside `write: ['dist/', '*.log']` binds the project's
 * children, not the project, so `out.log`, a declared output, fell into the
 * deny anchor's scratch and vanished under a green run. Each is bound
 * writable, as a file grant there is widened to its directory, and a write
 * there the glob does not cover is judged as one under a widened grant
 * (`refusedWrites`). A directory holding a wall never reaches here
 * (`wallOff` drops its glob).
 *
 * In the task's own directory the glob's directory is bound whether or not
 * a read grant shows it, where a tracer runs (it is made before, as an
 * output's static head is, `prepareOutputsForBind`): an output `*.js` at
 * the project root, `dist/*.js` before `dist` exists, or a recursive one,
 * fell into the scratch and failed the task as a write gone with the
 * sandbox (conformance sandbox/root-glob-output-passes). What was there
 * at the start is judged as a widened grant's is: a read of it no grant
 * covers is a violation (`parseStraceViolations`).
 */
function punchedWriteGlobs(
  globs: readonly string[],
  shown: readonly string[],
  writeBinds: readonly string[],
  own?: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (process.platform !== 'linux') return out
  for (const glob of globs) {
    const dir = globDir(glob)
    const mine = own !== undefined && atOrUnder(dir, own)
    if (
      (!mine && !shown.some((r) => atOrUnder(dir, r))) ||
      writeBinds.some((b) => atOrUnder(dir, b))
    )
      continue
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    out.set(dir, [...(out.get(dir) ?? []), glob])
  }
  return out
}

/**
 * A read grant with the WALLS inside it cut out: the directories of the
 * projects nested in this one, the repository and vx's own directory. A
 * root project's `read: ['.']` bound every nested project, `.git` and the
 * cache readable, and the key, which excludes nested projects, replayed a
 * nested file's old bytes (item 1010). The cut is the punch above, a wall
 * dropped where a write path is bound: its siblings are granted, the wall
 * is not. A grant that IS a wall, or lies inside one, names it on purpose
 * and stays. Linux only, as the punch is; a grant with no wall under it
 * costs nothing.
 */
export function punchWalls(readPath: string, walls: readonly string[]): string[] {
  if (process.platform !== 'linux') return [readPath]
  const under = walls.filter((w) => w !== readPath && w.startsWith(readPath + path.sep))
  if (under.length === 0) return [readPath]
  let entries: string[]
  try {
    entries = readdirSync(readPath)
  } catch {
    return [readPath]
  }
  const out: string[] = []
  for (const entry of entries) {
    const child = path.join(readPath, entry)
    if (under.includes(child)) continue
    out.push(...punchWalls(child, under))
  }
  return out
}

/**
 * Expand a read grant so it is never an ANCESTOR of a write grant.
 *
 * bwrap builds the sandbox out of mounts, and SRT emits them write-first:
 * `--bind <out>` then `--ro-bind <readPath>`. When the read path is an
 * ancestor of the write path the read-only mount lands ON TOP of the
 * writable one and every write fails with `Read-only file system`
 * (`pushReadDenyDirMounts`, SRT 0.0.75 and 0.0.76 — its skip only covers the reverse
 * nesting). Verified in a Linux container 2026-09-05:
 *
 *   read=[proj]     write=[proj/dist]  → mkdir: Read-only file system
 *   read=[proj/src] write=[proj/dist]  → ok
 *   read=[proj]     no writes          → ok
 *
 * So punch the write paths out: grant the ancestor's children instead,
 * recursing only along the branches that actually contain one. Same probe,
 * same command: `read=[src, lib, package.json] write=[dist]` → ok. macOS
 * never needed this (seatbelt is precedence-based, not mounts), and it is
 * harmless there, so both platforms take the same path.
 *
 * A grant with no write path under it is returned untouched — the common
 * case costs nothing, not even a readdir.
 */
export function punchWritePaths(
  readPath: string,
  writePaths: readonly string[],
  /** Whether a link child's real path may be bound; one it may not is dropped. */
  reachable: (real: string) => boolean = () => true,
): string[] {
  // Linux only. The shadowing is a property of bwrap MOUNTS; macOS seatbelt
  // evaluates rules by precedence, so a read grant on a directory and a
  // write grant inside it coexist. Punching there costs the directory
  // ENTRY: granting every child is not granting the dir, so a command that
  // stats its own cwd — `bun build` — is denied it and dies with
  // `error: An unknown error occurred (Unexpected)` (2026-09-05).
  if (process.platform !== 'linux') return [readPath]
  const under = writePaths.filter((w) => w !== readPath && w.startsWith(readPath + path.sep))
  if (under.length === 0) return [readPath]
  let entries: string[]
  try {
    entries = readdirSync(readPath)
  } catch {
    // Unreadable or not a directory: nothing to expand, hand it over as is.
    return [readPath]
  }
  const out: string[] = []
  for (const entry of entries) {
    const child = path.join(readPath, entry)
    // A write path is already bound read-write, which is readable.
    if (under.includes(child)) continue
    // bwrap resolves a bind SOURCE, so a linked child bound as a read
    // grant is mounted as the directory it points at, and a package in a
    // pnpm or Bun isolated `node_modules` loses the store siblings its own
    // dependencies resolve through (vite: `Cannot find package
    // 'picomatch'`). vx lays it as the link it is instead
    // (`punchedLinks`), so its target must be in the sandbox already.
    try {
      if (lstatSync(child).isSymbolicLink()) {
        // A link out to a denied place (`node_modules -> ..`, `shared ->
        // ../b`) bound by its target granted what the whole grant never
        // did: bound unpunched, the link stays a link into the deny (item
        // 1006's glob hit, through the punch).
        if (!reachable(toRealPath(child))) continue
        out.push(child)
        continue
      }
    } catch {
      // vanished between readdir and lstat: nothing to bind either way
    }
    out.push(...punchWritePaths(child, under, reachable))
  }
  return out
}

/** Grants already reported — once per process, not per spawn. */
const warnedGlob = new Set<string>()

/**
 * SRT drops every Linux write path holding `[`, `]`, `*` or `?` (it reads
 * one as a glob, and a write path must be a path) or a backslash (Bun's
 * realpath refuses it; `bindableReads`), and no spelling keeps
 * it. Left in, the read grants were punched around a bind that never came,
 * the directory vanished from the task's view, its write read "Directory
 * nonexistent" with no word of the grant, and the refused write went
 * unreported, judged against it. Dropped from the binds instead, and said
 * once: the remedy is the deepest directory above it whose name holds none.
 */
function holdsGlobChar(grant: string): boolean {
  const stripped = srtStripped(grant)
  const glob = wildcardAt(stripped)
  const slash = stripped.indexOf('\\')
  const at = glob === -1 ? slash : slash === -1 ? glob : Math.min(glob, slash)
  if (at === -1) return false
  if (!warnedGlob.has(grant)) {
    warnedGlob.add(grant)
    notify({
      kind: 'line',
      tone: 'warn',
      text:
        `[vx] sandbox: the write grant ${grant} holds ${globChar(grant[at]!)}, and the Linux ` +
        `sandbox mounts no write path that does, so a write under it is refused. Grant the ` +
        `directory above it instead: ${grant.slice(0, grant.lastIndexOf(path.sep, at) + 1)}\n`,
    })
  }
  return true
}

/** A trailing `/**` SRT strips before it asks whether a path is a glob. */
const srtStripped = (grant: string): string => grant.replace(/\/\*\*$/, '')

const globChar = (c: string): string =>
  c === '[' || c === ']' ? 'a bracket' : c === '\\' ? 'a backslash' : `a ${c}`

/**
 * The files of `rels` (workspace-relative, as a key holds them) that no
 * read, write or baseline grant reaches: under the workspace's denial,
 * so not there inside the sandbox, whatever the task calls on them.
 * Judged from the request before the run: oxlint `statx`es its
 * `.oxlintrc.json` before it opens it, the trace records no stat, and the
 * task passed on the defaults. A grant holding a wildcard reaches as far
 * as its literal head and a write grant as far as its bind, and a file
 * `ignore.read` names is left out: a doubt lets a file through, never
 * refuses it. One Set lookup per ancestor of each file, no syscall per
 * file.
 */
export function keyedOutsideGrants(
  sandbox: {
    readonly baseAllowRead: readonly string[]
    readonly config: ResolvedSandboxConfig
  },
  workspaceRoot: string,
  rels: readonly string[],
): string[] {
  const head = (g: string): string => {
    const at = wildcardAt(g)
    return at === -1 ? g : g.slice(0, g.lastIndexOf(path.sep, at)) || path.sep
  }
  const { config } = sandbox
  const reach = new Set([...sandbox.baseAllowRead, ...config.allowRead].map(head))
  for (const g of [...config.allowWrite, ...(config.pendingWrites ?? [])])
    reach.add(process.platform === 'linux' ? bindOf(head(g)) : head(g))
  const reached = (abs: string): boolean => {
    for (let p = abs; ; p = path.dirname(p)) {
      if (reach.has(p)) return true
      if (path.dirname(p) === p) return false
    }
  }
  const ignore = config.ignore?.read ?? []
  const globs = ignore.map((pat) => new Bun.Glob(pat))
  // A grant from the request's own baselines may be spelled from the root
  // as given, one from the config canonical: the file is asked both ways.
  const real = toRealPath(workspaceRoot)
  const out: string[] = []
  for (const rel of rels) {
    const abs = path.join(real, rel)
    if (reached(abs) || (real !== workspaceRoot && reached(path.join(workspaceRoot, rel)))) continue
    if (!ignore.includes(abs) && !globs.some((g) => g.match(abs))) out.push(abs)
  }
  return out
}

/**
 * Linux: the read grants SRT can mount as the paths they are. It reads
 * one holding `*` or `?` as a glob and mounts every match, and no spelling
 * makes either literal (its rewrite of each runs inside a class too), so a
 * grant of `a*b.txt` granted `aXb.txt`. One holding a backslash it skips:
 * Bun's `realpathSync` throws ENOENT on such a path (Node's does not), and
 * SRT mounts no path it cannot resolve. Left out, so a read of it is
 * refused and reported, and said once; a bracket has a spelling
 * (`literalReadPaths`).
 */
export function bindableReads(paths: readonly string[]): string[] {
  if (process.platform !== 'linux') return [...paths]
  return paths.filter((grant) => {
    const head = namedHead(grant).length
    const past = srtStripped(grant)
      .slice(head)
      .search(/[*?\\]/)
    if (past === -1) return true
    const at = head + past
    if (!warnedGlob.has(grant)) {
      warnedGlob.add(grant)
      notify({
        kind: 'line',
        tone: 'warn',
        text:
          `[vx] sandbox: the read grant ${grant} holds ${globChar(grant[at]!)}, which the Linux ` +
          `sandbox ${grant[at] === '\\' ? 'cannot resolve' : 'reads as a pattern that also matches its siblings'}, so it is not granted. ` +
          `Rename it, or grant the directory above it: ` +
          `${grant.slice(0, grant.lastIndexOf(path.sep, at) + 1)}\n`,
      })
    }
    return false
  })
}

/**
 * Merge the orchestrator-provided baseline (declared inputs / outputs /
 * workspace-root anchor) with the user's resolved sandbox block to
 * produce the SRT customConfig. Path arrays are unioned and deduped; every
 * read grant is punched around the write grants (`punchWritePaths`).
 *
 * Network: the lists are passed as the task declared them, but SRT's
 * proxy filters by the RUN's lists from `initialize()`, never these: a
 * task reaches the run's allowlist union less its deny union
 * (`sandboxRunUnion`, B-21), whatever it declared here.
 */
export function buildCustomConfig(
  args: Pick<SandboxedRunArgs, 'config'>,
  baselines: {
    allowRead: readonly string[]
    denyRead: readonly string[]
    /** The task's directory: a write glob's directory in it is bound even unshown. */
    cwd?: string | undefined
  },
): TaskSandboxConfig {
  const c = args.config
  const denyRead = unique([...baselines.denyRead])
  const allowWrite = bindableWrites(unique([...c.allowWrite]))
  // A link a write grant is spelled through is bound by vx, not SRT: a
  // read grant above it is punched around it all the same.
  const punched = [...allowWrite, ...linkedWriteBinds(c.linkedWrites).map(([, at]) => at)]
  const reads = [...baselines.allowRead, ...c.allowRead]
  // Asked only of a link a punch meets: a target under the deny anchor is
  // bound only where some read grant already reaches it.
  let fence: { denied: string[]; granted: string[] } | undefined
  const reachable = (real: string): boolean => {
    fence ??= { denied: denyRead.map(toRealPath), granted: reads.map(toRealPath) }
    // A target above a grant is laid as the link it is (`punchedLinks`),
    // which mounts nothing: behind it stands only what the grants bound.
    // Dropped, `shared -> ../lib/shared` hid a granted `../lib/shared/s.json`.
    return (
      !fence.denied.some((d) => atOrUnder(real, d)) ||
      fence.granted.some((g) => atOrUnder(real, g) || atOrUnder(g, real))
    )
  }
  let allowRead = unique(reads.flatMap((r) => punchWritePaths(r, punched, reachable)))
  const split = [
    ...punchedWriteGlobs(c.writeGlobs ?? [], c.allowRead, allowWrite, baselines.cwd).keys(),
  ]
  if (split.length > 0) {
    allowWrite.push(...split)
    punched.push(...split)
    allowRead = unique(reads.flatMap((r) => punchWritePaths(r, punched, reachable)))
  }

  const custom: TaskSandboxConfig = {
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite: [],
      ...(c.gitConfig !== undefined ? { allowGitConfig: c.gitConfig } : {}),
    },
  }

  // SRT requires both lists on any network config, so both are supplied;
  // its proxy filters by the run's lists, not these (see above).
  custom.network = {
    allowedDomains: c.network === true ? ['*'] : [...(c.network ?? [])],
    deniedDomains: [...(c.denyNetwork ?? [])],
    ...(c.unixSockets === true
      ? { allowAllUnixSockets: true }
      : c.unixSockets !== undefined
        ? { allowUnixSockets: [...c.unixSockets] }
        : {}),
    ...(c.localBinding !== undefined ? { allowLocalBinding: localBindingOn(c) } : {}),
    ...(c.machLookup !== undefined ? { allowMachLookup: [...c.machLookup] } : {}),
  }

  if (c.pty !== undefined) custom.allowPty = c.pty
  if (c.weakerWhenNested !== undefined) {
    custom.enableWeakerNestedSandbox = c.weakerWhenNested
  }
  if (c.weakerNetworkIsolation !== undefined) {
    custom.enableWeakerNetworkIsolation = c.weakerNetworkIsolation
  }
  return custom
}

/**
 * Linux: SRT's bwrap line with each `--tmpfs` it lays over a read-denied
 * directory (the workspace root, a sibling's tree, the cwd with no read
 * grant) remounted read-only once the mounts beneath it are made. bwrap's
 * tmpfs is writable, so a write there succeeded and vanished with the
 * sandbox: a task that wrote `../../dist` went green with its output gone,
 * where seatbelt refuses the same write. Now it is `EROFS` on both, and a
 * failed task's hint names the path. The mask a `scratch` glob's writes
 * land in stays writable: that is the grant (`scratchWrites`). Placed
 * before the `--` that ends bwrap's options; the words are SRT's own
 * quoting, copied as they are.
 */
export function readOnlyMasks(wrapped: string, scratch: readonly string[] = []): string {
  const masks: string[] = []
  let prev = ''
  for (const m of wrapped.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g)) {
    if (m[0] === '--') {
      const held = scratch.map((g) => {
        const dir = toRealPath(globDir(g))
        const holding = masks.filter((w) => atOrUnder(dir, unquoted(w)))
        return holding.sort((a, b) => unquoted(b).length - unquoted(a).length)[0]
      })
      const ro = masks.filter((w) => !held.includes(w))
      if (ro.length === 0) return wrapped
      const words = ro.map((w) => `--remount-ro ${w} `).join('')
      return `${wrapped.slice(0, m.index)}${words}${wrapped.slice(m.index)}`
    }
    if (prev === '--tmpfs') masks.push(m[0])
    prev = m[0]
  }
  return wrapped
}

/** A word as SRT's `quote` spells it, read back: single-quoted runs and `"'"`. */
const unquoted = (word: string): string =>
  word.replace(/'([^']*)'|"([^"]*)"/g, (_, a: string | undefined, b: string | undefined) => a ?? b!)

/**
 * Linux: the task's output directories, staged so the task may remove
 * them. A write grant is a bind, and a mount point cannot be removed:
 * `rm -rf dist && tsc` under `dist/` met "Read-only file system"
 * (conformance sandbox/clean-and-rebuild-output-dir-passes). Where the
 * task's directory is held by a read-only mask (no grant binds it, or
 * anything above it), each granted directory there that the task's
 * outputs claim whole (`dist/**`) is linked, file by file, into a stage
 * of vx's own (`.vx/tmp/<pid>-<tag>`, on the workspace's filesystem), and
 * the stage is bound AS the task's directory, under the binds of its
 * other grants; the output directory is then a plain directory inside it.
 * The host's directory stays as it was meanwhile: a concurrent task still
 * reads it, and a killed run loses nothing (its stage is swept). After the
 * task each staged directory replaces the host's (the host's goes when
 * the task removed it and made none); the rest (mount points bwrap made,
 * a stray write vx reports) goes with the stage. Returns the line and the
 * restore, which throws when a replace fails, or undefined where nothing
 * is staged.
 */
export function stagedOutputs(
  wrapped: string,
  opts: {
    cwd: string
    allowRead: readonly string[]
    allowWrite: readonly string[]
    /** The write grants as the task declared them, canonical. */
    granted: readonly string[]
    /** Grants spelled through a link: bound at the link too, so left in place. */
    linked?: readonly { link: string; target: string }[] | undefined
    /** Directories the task's outputs claim whole: nothing else is staged. */
    owned: readonly string[]
    tag: string
  },
): { wrapped: string; restore: () => void } | undefined {
  const { cwd } = opts
  if (process.platform !== 'linux') return undefined
  // The task's directory is bound itself, or under a bind: nothing to stage there.
  if ([...opts.allowRead, ...opts.allowWrite].some((g) => atOrUnder(cwd, g))) return undefined
  const owned = opts.owned.map((o) => {
    try {
      return realpathSync(o)
    } catch {
      return o
    }
  })
  const dirs = opts.granted.filter((g) => {
    if (path.dirname(g) !== cwd || !isMountableLiteral(g) || !owned.includes(g)) return false
    if (opts.linked?.some((l) => l.target === g || atOrUnder(l.target, g))) return false
    try {
      return lstatSync(g).isDirectory()
    } catch {
      return false
    }
  })
  if (dirs.length === 0) return undefined
  const words = [...wrapped.matchAll(/(?:'[^']*'|"[^"]*"|[^\s'"])+/g)]
  const end = words.findIndex((w) => w[0] === '--')
  if (end === -1) return undefined
  // Only a directory the line names nowhere but in its own write bind is
  // staged: a deny or mask in it (`.mcp.json`, `.git/hooks`) is a mount
  // that moves with a renamed directory, so a staged one would let the task
  // rebuild it unprotected and the restore land that on the host.
  const own = (i: number, d: string): boolean =>
    (words[i - 1]?.[0] === '--bind' &&
      unquoted(words[i]![0]) === d &&
      unquoted(words[i + 1]![0]) === d) ||
    (words[i - 2]?.[0] === '--bind' &&
      unquoted(words[i - 1]![0]) === d &&
      unquoted(words[i]![0]) === d)
  for (let k = dirs.length - 1; k >= 0; k--) {
    const d = dirs[k]!
    for (let i = 0; i < end; i++) {
      const w = unquoted(words[i]![0])
      if (!atOrUnder(w, d)) continue
      if (w === d && own(i, d)) continue
      dirs.splice(k, 1)
      break
    }
  }
  if (dirs.length === 0) return undefined
  // The deepest mask holding the task's directory is where the stage is bound.
  const masks: { at: number; path: string }[] = []
  for (let i = 0; i < end - 1; i++) {
    if (words[i]![0] !== '--tmpfs') continue
    const m = unquoted(words[i + 1]![0])
    if (atOrUnder(cwd, m)) masks.push({ at: i + 1, path: m })
  }
  // A mask AT the task's directory is remounted read-only after the stage
  // would be bound there, and the stage with it.
  if (masks.length === 0 || masks.some((m) => m.path === cwd)) return undefined
  masks.sort((a, b) => b.path.length - a.path.length || b.at - a.at)
  const mask = masks[0]!
  const stageRoot = nearestVx(cwd)
  if (stageRoot === undefined) return undefined
  // Named as a restore's staging is, so a killed run's is swept (`sweepStaging`).
  const stage = path.join(stageRoot, 'tmp', `${process.pid.toString(36)}-${opts.tag}`)
  const restore = (): void => {
    const failed: string[] = []
    for (const d of dirs) {
      const fresh = path.join(stage, path.basename(d))
      const old = path.join(stage, `.host-${path.basename(d)}`)
      const made = lstatSync(fresh, { throwIfNoEntry: false })
      // A link or file in its place would land on the host where the grant
      // let the task write only inside a directory.
      if (made !== undefined && !made.isDirectory()) {
        failed.push(d)
        continue
      }
      try {
        renameSync(d, old)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          failed.push(d)
          continue
        }
      }
      if (made === undefined) continue
      try {
        renameSync(fresh, d)
      } catch {
        failed.push(d)
        try {
          renameSync(old, d)
        } catch {
          // Something made it meanwhile: what the task left is lost, and said so below.
        }
      }
    }
    rmSync(stage, { recursive: true, force: true })
    if (failed.length > 0)
      throw new Error(`vx: could not put the task's output back in place: ${failed.join(', ')}`)
  }
  try {
    mkdirSync(stage, { recursive: true })
    for (const d of dirs) linkTree(d, path.join(stage, path.basename(d)))
  } catch {
    rmSync(stage, { recursive: true, force: true })
    return undefined
  }
  // Drop each staged directory's binds; bind the stage as the task's directory after the mask.
  const drop = new Set<number>()
  for (let i = 0; i < end - 2; i++) {
    if (words[i]![0] !== '--bind') continue
    const dest = unquoted(words[i + 2]![0])
    if (dirs.includes(dest) && unquoted(words[i + 1]![0]) === dest)
      drop
        .add(i)
        .add(i + 1)
        .add(i + 2)
  }
  let out = ''
  let last = 0
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (drop.has(i)) {
      out += wrapped.slice(last, w.index)
      last = w.index! + w[0].length
      continue
    }
    if (i === mask.at) {
      out += wrapped.slice(last, w.index! + w[0].length)
      out += ` --bind ${shellQuote(stage)} ${shellQuote(cwd)}`
      last = w.index! + w[0].length
    }
  }
  out += wrapped.slice(last)
  return { wrapped: out, restore }
}

/** The `.vx` nearest above `dir`: the workspace's, which `sweepStaging` sweeps. */
function nearestVx(dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    const vx = path.join(d, '.vx')
    if (statSync(vx, { throwIfNoEntry: false })?.isDirectory() === true) return vx
    if (path.dirname(d) === d) return undefined
  }
}

/**
 * A copy of `from` at `to` whose files are hard links: no byte is copied.
 * Each directory keeps its mode, set once filled (a read-only one could
 * take nothing): the restore puts the copy on the host, and a 0700 one
 * came back at the umask's mode.
 */
function linkTree(from: string, to: string): void {
  mkdirSync(to)
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name)
    const dst = path.join(to, e.name)
    if (e.isDirectory()) linkTree(src, dst)
    else if (e.isSymbolicLink()) symlinkSync(readlinkSync(src), dst)
    else linkSync(src, dst)
  }
  chmodSync(to, statSync(from).mode & 0o7777)
}
