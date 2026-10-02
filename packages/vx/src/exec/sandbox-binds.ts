// Write grants as bwrap can honour them, and the SRT custom config built
// from the resolved policy: a file-shaped grant widened to its directory,
// a read grant punched around the write grants inside it, the network
// lists SRT insists on receiving in full.

import { lstatSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  atOrUnder,
  isMountableLiteral,
  localBindingOn,
  MOUNT_WILDCARDS,
  unique,
} from './sandbox-paths.js'
import type { SandboxedRunArgs } from './sandbox-runtime.js'

type SrtModule = typeof import('@anthropic-ai/sandbox-runtime')

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
 * widening — the task may write its siblings — and it is the narrowest
 * grant the mechanism can express: the alternative is a declared output
 * the task cannot produce. macOS needs none of this (seatbelt matches
 * paths, it does not mount), so the grant stays exact there.
 */
export function bindableWrites(paths: readonly string[]): string[] {
  if (process.platform !== 'linux') return [...paths]
  return unique(
    paths
      .filter((p) => !holdsGlobChar(p))
      .map((p) => {
        if (!isMountableLiteral(p)) return p
        try {
          if (statSync(p).isDirectory()) return p
        } catch {
          // Does not exist yet: `prepareOutputsForBind` creates a file for a
          // file-shaped grant, so treat it as one.
        }
        return path.dirname(p)
      }),
  )
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
    const dir = path.dirname(glob.slice(0, glob.search(MOUNT_WILDCARDS) + 1))
    const free = anchors.some((a) => atOrUnder(dir, a)) && !binds.some((b) => atOrUnder(dir, b))
    ;(free ? scratch : mountless).push(glob)
  }
  return { scratch, mountless }
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

/** Directories already warned about below — once per process, not per spawn. */
const warnedSymlinkPunch = new Set<string>()

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
export function punchWritePaths(readPath: string, writePaths: readonly string[]): string[] {
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
  const linked: string[] = []
  for (const entry of entries) {
    const child = path.join(readPath, entry)
    // A write path is already bound read-write, which is readable.
    if (under.includes(child)) continue
    // bwrap resolves a bind SOURCE, so a symlinked child is mounted as the
    // directory it points at: inside the sandbox the link is gone. For a
    // package in Bun's isolated node_modules layout that severs it from
    // the `.bun/` siblings its own dependencies resolve through — astro
    // could not find `yargs-parser` for four days of red CI (2026-09-09).
    // SRT's config carries no `--symlink`, so the only fix is the grant:
    // say which one, loudly.
    try {
      if (lstatSync(child).isSymbolicLink()) linked.push(child)
    } catch {
      // vanished between readdir and lstat: nothing to bind either way
    }
    out.push(...punchWritePaths(child, under))
  }
  if (linked.length > 0 && !warnedSymlinkPunch.has(readPath)) {
    warnedSymlinkPunch.add(readPath)
    process.stderr.write(
      `[vx] sandbox: a write grant under ${readPath} makes its ${linked.length} symlinked ` +
        `entr${linked.length === 1 ? 'y' : 'ies'} (${linked
          .slice(0, 3)
          .map((l) => path.basename(l))
          .join(', ')}${linked.length > 3 ? ', …' : ''}) plain directories inside the sandbox — ` +
        `a package resolved through one loses its siblings. Move the write grant (${under
          .map((w) => path.relative(readPath, w))
          .join(', ')}) out of it.\n`,
    )
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
  const at = srtStripped(grant).search(/[[\]*?\\]/)
  if (at === -1) return false
  if (!warnedGlob.has(grant)) {
    warnedGlob.add(grant)
    process.stderr.write(
      `[vx] sandbox: the write grant ${grant} holds ${globChar(grant[at]!)}, and the Linux ` +
        `sandbox mounts no write path that does, so a write under it is refused. Grant the ` +
        `directory above it instead: ${grant.slice(0, grant.lastIndexOf(path.sep, at) + 1)}\n`,
    )
  }
  return true
}

/** A trailing `/**` SRT strips before it asks whether a path is a glob. */
const srtStripped = (grant: string): string => grant.replace(/\/\*\*$/, '')

const globChar = (c: string): string =>
  c === '[' || c === ']' ? 'a bracket' : c === '\\' ? 'a backslash' : `a ${c}`

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
    const at = srtStripped(grant).search(/[*?\\]/)
    if (at === -1) return true
    if (!warnedGlob.has(grant)) {
      warnedGlob.add(grant)
      process.stderr.write(
        `[vx] sandbox: the read grant ${grant} holds ${globChar(grant[at]!)}, which the Linux ` +
          `sandbox ${grant[at] === '\\' ? 'cannot resolve' : 'reads as a pattern that also matches its siblings'}, so it is not granted. ` +
          `Rename it, or grant the directory above it: ` +
          `${grant.slice(0, grant.lastIndexOf(path.sep, at) + 1)}\n`,
      )
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
  },
): Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] {
  const c = args.config
  const denyRead = unique([...baselines.denyRead])
  const allowWrite = bindableWrites(unique([...c.allowWrite]))
  const allowRead = unique(
    [...baselines.allowRead, ...c.allowRead].flatMap((r) => punchWritePaths(r, allowWrite)),
  )

  const custom: Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] = {
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
