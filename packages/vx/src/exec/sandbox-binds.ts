// Write grants as bwrap can honour them, and the SRT custom config built
// from the resolved policy: a file-shaped grant widened to its directory,
// a read grant punched around the write grants inside it, the network
// lists SRT insists on receiving in full.

import { lstatSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { localBindingOn, unique } from './sandbox-paths.js'
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
function bindableWrites(paths: readonly string[]): string[] {
  if (process.platform !== 'linux') return [...paths]
  return unique(
    paths.map((p) => {
      if (/[*?[\]]/.test(p)) return p
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

/** Directories already warned about below — once per process, not per spawn. */
const warnedSymlinkPunch = new Set<string>()

/**
 * Expand a read grant so it is never an ANCESTOR of a write grant.
 *
 * bwrap builds the sandbox out of mounts, and SRT emits them write-first:
 * `--bind <out>` then `--ro-bind <readPath>`. When the read path is an
 * ancestor of the write path the read-only mount lands ON TOP of the
 * writable one and every write fails with `Read-only file system`
 * (`pushReadDenyDirMounts`, SRT 0.0.75 — its skip only covers the reverse
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

/**
 * Merge the orchestrator-provided baseline (declared inputs / outputs /
 * workspace-root anchor) with the user's resolved sandbox block to
 * produce the SRT customConfig. Path arrays are unioned and deduped; every
 * read grant is punched around the write grants (`punchWritePaths`).
 *
 * Network: `allow.network` missing → block all (allowedDomains: []);
 * `true` → allow all (['*']); a domain list → exactly that list.
 * `deny.network` is always passed as deniedDomains.
 */
export function buildCustomConfig(
  args: Pick<SandboxedRunArgs, 'config'>,
  baselines: {
    allowRead: readonly string[]
    allowWrite: readonly string[]
    denyRead: readonly string[]
  },
): Parameters<SrtModule['SandboxManager']['wrapWithSandbox']>[2] {
  const c = args.config
  const denyRead = unique([...baselines.denyRead])
  const allowWrite = bindableWrites(unique([...baselines.allowWrite, ...c.allowWrite]))
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

  // `allow.network` / `deny.network` become SRT's domain lists. SRT requires
  // both to be present on any network config, so we always supply both;
  // omitted means no network at all.
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
