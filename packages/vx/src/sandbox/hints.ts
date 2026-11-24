// vx's notes beside a task's denials: what to grant, key or move. Each is
// a `hint`, never a denial of its own.

import path from 'node:path'
import os from 'node:os'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import type { SandboxViolation } from '../exec/index.js'
import { procfsIsOwn, relPosix, taskGlobOf } from '../util/index.js'
import { bindableWrites } from './binds.js'
import { atOrUnder, loopbackPorts, toRealPath } from './paths.js'
import { srtDefaultWritePaths } from './deny-scan.js'
import { hiddenLink, hiddenReadsOutside, refusedWritesOutside } from './violations.js'
import type { SandboxedRunArgs, Ended, Denials, Wrap } from './runtime.js'
import { taskTmpRoot } from './tmp.js'
import { bridgedPorts } from './bridges.js'

/**
 * vx's own notes beside the denials, each a `hint` never counted as one,
 * and all but the upstream note on a failure only, so none can redden a
 * pass. Pushed onto `denials.violations`.
 */
export function addHints(
  args: SandboxedRunArgs,
  ended: Ended,
  denials: Denials,
  baselines: Wrap['baselines'],
): void {
  const { exitCode, signs, outTail, errTail } = ended
  const { recorded, violations, grantedRead } = denials
  // A write refused past the wall is not a violation (nothing a key reads),
  // but it may be why the task failed. A write refused in a dependency's
  // outputs is that project's task's work, never a grant here: `tsc -b`
  // under --exclude-dependencies rebuilt its upstream, and the hints named
  // `write: ['../p00/']`.
  const upstream = (args.upstreamOutputs ?? []).map(toRealPath)
  const isUpstream = (p: string | undefined): p is string =>
    p !== undefined && upstream.some((u) => atOrUnder(p, u))
  const upstreamWrites = new Set(
    violations
      .filter((v) => v.hint !== true && v.opened !== 'read' && v.ignorable?.includes('write'))
      .map((v) => v.path)
      .filter(isUpstream),
  )
  if (exitCode !== 0) {
    const refused = refusedWritesOutside(recorded, {
      within: args.reportWithin,
      linked: args.reportLinked,
      config: args.config,
      skip: [taskTmpRoot(), ...srtDefaultWritePaths()],
    })
    for (const p of refused.filter(isUpstream)) upstreamWrites.add(p)
    const outside = refused.filter((p) => !isUpstream(p))
    if (outside.length > 0) {
      const made = new Set(
        recorded.filter((v) => /^mkdir(?:at)?\(/.test(v.line)).map((v) => v.path),
      )
      violations.push(outsideWritesHint(outside, made, baselines.denyRead, args.reportWithin))
    }
    if (process.platform === 'linux') {
      const removed = grantRemovalHint(
        // Playwright says it on stdout, removing its own outputDir: its
        // tail, read on a failure only, as `statedHiddenHint` reads it.
        [
          ...signs.readOnlyLines,
          ...outTail
            .text()
            .split('\n')
            .filter((l) => READ_ONLY_FS.test(l))
            .slice(-64),
        ],
        bindableWrites(args.config.allowWrite),
        args.cwd,
        args.reportWithin,
      )
      if (removed !== undefined) violations.push(removed)
      const hidden = hiddenUnderGrantHint(
        [
          ...signs.readOnlyLines,
          ...outTail
            .text()
            .split('\n')
            .filter((l) => READ_ONLY_FS.test(l))
            .slice(-64),
        ],
        bindableWrites(args.config.allowWrite),
        baselines.denyRead,
      )
      if (hidden !== undefined) violations.push(hidden)
    }
  }
  if (upstreamWrites.size > 0)
    violations.push(upstreamWritesHint([...upstreamWrites], args.reportWithin))

  // The one denial macOS never logs: with the cwd outside every read
  // grant the process dies before macOS logs anything, and the child
  // reports what it likes (`bun test`: `An unknown error occurred`). Not a
  // guess: the cwd lying outside every allowRead prefix is a fact of the
  // resolved baselines. Added only when the task already failed with
  // nothing to show.
  if (exitCode !== 0 && violations.length === 0 && !readableUnder(args.cwd, grantedRead)) {
    violations.push({
      timestamp: new Date(),
      hint: true,
      line:
        `vx: this sandbox grants no read access to the task's own working directory ` +
        `(${args.cwd}), so a command that reads or lists it fails with whatever error it ` +
        `reports for that — macOS logs no violation record. Add ` +
        "`sandbox: { allow: { read: ['.'] } }`.",
    })
  }

  if (exitCode !== 0) {
    const hidden = hiddenReadsOutside(recorded, {
      within: args.reportWithin,
      linked: args.reportLinked,
      config: args.config,
      skip: [taskTmpRoot()],
    })
    if (hidden.length > 0)
      violations.push(hiddenReadsHint(hidden, baselines.denyRead, args.reportWithin, keyOf(args)))
    const git = signs.gitNoRepo
      ? hiddenGitHint(args.cwd, grantedRead, baselines.denyRead, args.reportWithin)
      : undefined
    if (git !== undefined && !hidden.some((p) => atOrUnder(p, git.dir))) violations.push(git.hint)
    if (process.platform === 'linux') {
      // tsc prints its errors on stdout.
      const named = statedHiddenHint(
        `${outTail.text()}\n${errTail.text()}`
          .split('\n')
          .filter((l) => NOT_FOUND.test(l))
          .slice(-64),
        args.cwd,
        [...grantedRead, ...args.config.allowWrite],
        args.config.allowRead,
        baselines.denyRead,
        args.reportWithin,
        // `recorded`, not only what is reported: a traced denial an `ignore`
        // entry silenced was asked for, and naming it here undid the entry.
        [
          ...[...recorded, ...violations].map((v) => v.path),
          ...hidden,
          ...(git === undefined ? [] : [git.dir]),
        ],
        keyOf(args),
      )
      if (named !== undefined) violations.push(named)
      const refused = refusedLoopbackHint(
        `${outTail.text()}\n${errTail.text()}`.split('\n').slice(-64),
        [...loopbackPorts(args.config.network), ...bridgedPorts(args.config)],
      )
      if (refused !== undefined) violations.push(refused)
      if (args.config.unixSockets === undefined) {
        const unix = refusedUnixSocketHint(
          `${outTail.text()}\n${errTail.text()}`.split('\n').slice(-64),
        )
        if (unix !== undefined) violations.push(unix)
      }
      // Last, and only when nothing else was said: a grant inside the cwd
      // lists it (bwrap builds the path to a bind), but only that grant, so
      // `bun test` and Vitest scan it, find no test file, and fail with no
      // read to report.
      const cwd = toRealPath(args.cwd)
      // A grant cut around the walls (a root's `read: ['.']`) covers the cwd.
      const granted = [...grantedRead, ...(args.config.walled?.reads ?? [])].map(toRealPath)
      if (violations.length === 0 && !granted.some((g) => atOrUnder(cwd, g))) {
        const inside = [
          ...new Set(
            granted
              // A baseline the host lacks (no node_modules) is bound to nothing.
              .filter(
                (g) =>
                  g !== cwd &&
                  atOrUnder(g, cwd) &&
                  statSync(g, { throwIfNoEntry: false }) !== undefined,
              )
              .map((g) => relPosix(cwd, g)),
          ),
        ]
        violations.push({
          timestamp: new Date(),
          hint: true,
          line:
            inside.length === 0
              ? `vx: this sandbox grants no read of the task's own working directory (${args.cwd}) ` +
                'or of anything inside it, so the command sees it empty, and no violation names that. ' +
                "Grant what it reads, or the directory: `sandbox: { allow: { read: ['.'] } }`."
              : `vx: this sandbox grants no read of the task's own working directory (${args.cwd}), ` +
                `only of ${inside.length > 4 ? `${inside.slice(0, 4).join(', ')}, …` : inside.join(', ')} inside it, ` +
                'so a command that lists it (a test runner looking for its files) sees nothing else, ' +
                'and no violation names that. Grant what it lists, or the directory: ' +
                "`sandbox: { allow: { read: ['.'] } }`.",
        })
      }
    }
  }
}

/**
 * The hint for writes refused outside the project, a few paths named, and
 * a grant for each: a sandboxed `go build` on a fresh home was refused its
 * telemetry file and then `mkdir ~/.cache`, and the hint granted only the
 * first one's directory, which left the build failing (2026-11-11).
 * `made` holds the paths a refused `mkdir` named: the directory itself is
 * the grant, not its parent.
 */
export function outsideWritesHint(
  paths: readonly string[],
  made: ReadonlySet<string | undefined>,
  walled: readonly string[],
  within: string,
): SandboxViolation {
  const shown = paths.slice(0, 5).join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  const refused =
    `vx: the sandbox refused writes outside the project, which are not reported as ` +
    `violations: ${shown}${more}.`
  const home = toRealPath(os.homedir())
  const walls = walled.map(toRealPath)
  // Granting a system temp directory opens it to every write of the task;
  // the task already has a temp directory of its own. A workspace kept
  // under one is the workspace, and its directory is the grant.
  // A home kept under one (a CI container's, an agent's) is home: a tool
  // writes its store there whatever $TMPDIR says.
  const temps = hostTempRoots()
  const inHome = (p: string): boolean => atOrUnder(p, home) && !temps.includes(home)
  const scratchTemp = (p: string): boolean =>
    temps.some((t) => atOrUnder(p, t)) && !walls.some((w) => atOrUnder(p, w)) && !inHome(p)
  const isDir = (p: string): boolean =>
    made.has(p) || statSync(p, { throwIfNoEntry: false })?.isDirectory() === true
  // A tool's cache under `~/.cache` is its own directory there: `go build`
  // writes `~/.cache/go-build/ab/<hash>-d`, and `ab/` alone failed the next
  // build on another subdirectory.
  const homeCache = path.join(home, '.cache')
  const toolCache = (p: string): string | undefined => {
    if (!atOrUnder(p, homeCache) || p === homeCache) return undefined
    const tool = p.slice(homeCache.length + 1).split('/')[0]
    return `${homeCache}/${tool}`
  }
  // Never home or above it: a tool's own `~/.cache` (or `~/.npmrc`) is the grant.
  // Nor a directory holding the project: a task writing `../shared.txt`
  // was told to grant `../`, every sibling project writable.
  const project = toRealPath(within)
  const grantOf = (p: string): string => {
    const cache = toolCache(p)
    if (cache !== undefined && (cache !== p || isDir(p))) return `${cache}/`
    const dir = path.dirname(p)
    return isDir(p) ? `${p}/` : atOrUnder(home, dir) || atOrUnder(project, dir) ? p : `${dir}/`
  }
  const grants = [...new Set(paths.filter((p) => !scratchTemp(p)).map(grantOf))].filter(
    (g, _, all) =>
      !all.some(
        (o) => o !== g && o.endsWith('/') && atOrUnder(g.replace(/\/$/, ''), o.slice(0, -1)),
      ),
  )
  const temp = paths.some(scratchTemp)
    ? ` The task has its own temp directory, empty at its start: write under ` +
      `$TMPDIR (os.tmpdir() in Node and Bun) instead of a fixed path.`
    : ''
  const spelled = grants.slice(0, 3).map((g) => {
    const s = grantSpelling(g.endsWith('/') ? g.slice(0, -1) : g, walled, within)
    return jsString(g.endsWith('/') && !s.endsWith('/') ? `${s}/` : s)
  })
  const one = grants.length === 1
  const dirs = grants.every((g) => g.endsWith('/'))
  const what = dirs ? (one ? 'its directory' : 'their directories') : one ? 'it' : 'them'
  const line =
    grants.length === 0
      ? `${refused}${temp}`
      : `${refused} If the task needs ${one ? 'one' : 'them'}, grant ${what}, e.g. ` +
        `\`allow: { write: [${spelled.join(', ')}] }\`.${temp}`
  return { timestamp: new Date(), hint: true, line }
}

/**
 * The note for writes refused in a dependency's declared outputs: that
 * project's own task writes them, so the remedy is to run it, or to keep
 * this task from rebuilding it, never a grant to write there.
 */
function upstreamWritesHint(paths: readonly string[], within: string): SandboxViolation {
  const real = toRealPath(within)
  const shown = paths
    .slice(0, 5)
    .map((p) => path.relative(real, p))
    .join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: the task tried to write a dependency's declared outputs (${shown}${more}), which that ` +
      `project's own task writes. Run it with its dependencies (drop --exclude-dependencies), ` +
      `or keep the task from rebuilding them (\`tsc -p\`, not \`tsc -b\`); a write grant there ` +
      `is not the fix.`,
  }
}

/**
 * Linux: a directory write grant is a bind mount, and a mount point cannot
 * be removed or renamed, so `rm -rf dist` empties it and then fails with
 * "Read-only file system" (EBUSY under a writable parent). Binding the
 * parent instead would let the task write beside the grant, so the
 * removal stays refused; a failure whose stderr, or stdout's tail, names
 * a grant on such an error line gets the spelling that works.
 */
function grantRemovalHint(
  lines: readonly string[],
  roots: readonly string[],
  cwd: string,
  within: string,
): SandboxViolation | undefined {
  if (lines.length === 0) return undefined
  const named = roots.filter((root) => {
    const rel = path.relative(cwd, root)
    const spellings = rel === '' ? [root] : [root, rel]
    return spellings.some((s) => {
      const re = new RegExp(`(^|[\\s'"\`(])(\\./)?${RegExp.escape(s)}/?($|[\\s'"\`:,)])`)
      return lines.some((l) => re.test(l))
    })
  })
  if (named.length === 0) return undefined
  const grants = named.map((r) => `'${path.relative(within, r) || '.'}/'`).join(', ')
  const contents = path.relative(cwd, named[0]!) || '.'
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: the write grant ${grants} is mounted in place on Linux: the task may empty it ` +
      `but not remove or rename it ("Read-only file system"). Remove its contents ` +
      `instead, e.g. \`rm -rf ${contents}/*\`, and give a tool that removes its own ` +
      `output directory one inside it (Playwright: \`--output ${contents}/run\`).`,
  }
}

/**
 * Linux: a path the sandbox hides inside a write grant (a credential store,
 * `~/.expo/state.json` under `write: ['~/.expo/']`) is masked by a mount, so
 * a tool that writes it by rename fails with "resource busy", the grant
 * looking whole. A failure whose output names one gets the grant that
 * opens it: by name, as a store is granted.
 */
function hiddenUnderGrantHint(
  lines: readonly string[],
  roots: readonly string[],
  denied: readonly string[],
): SandboxViolation | undefined {
  if (lines.length === 0) return undefined
  const named = denied.filter(
    (d) =>
      roots.some((r) => d !== r && atOrUnder(d, r)) &&
      lines.some((l) => new RegExp(`(^|[\\s'"\`(])${RegExp.escape(d)}($|[\\s'"\`:,)])`).test(l)),
  )
  if (named.length === 0) return undefined
  const home = toRealPath(os.homedir())
  const spelled = named.map((d) => `'${atOrUnder(d, home) ? `~/${path.relative(home, d)}` : d}'`)
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: ${spelled.join(', ')} ${named.length === 1 ? 'lies' : 'lie'} inside a write grant, but the sandbox hides ` +
      `${named.length === 1 ? 'it' : 'them'} (a credential store), so the task can neither read ` +
      `nor replace ${named.length === 1 ? 'it' : 'them'} ("resource busy"). If the task must, grant ` +
      `${named.length === 1 ? 'it' : 'them'} by name: \`allow: { write: [${spelled.join(', ')}] }\`.`,
  }
}

/** An output line that may say a removal of a write grant was refused (`grantRemovalHint`). */
export const READ_ONLY_FS = /Read-only file system|EROFS|EBUSY|resource busy/i

/** git's word, on stderr, for a discovery that found no `.git`. */
export const GIT_NO_REPO = /not a git repository/i

/**
 * The hint for git finding no repository because the sandbox hid `.git`.
 * git probes it by `stat` alone, which strace does not stop on
 * (`TRACED_CALLS`: a stop per stat cost every sandboxed task), so no
 * record names it; git's own words (`GIT_NO_REPO`) do, and a failed task
 * that said them is the only one looked at. The `.git`
 * nearest the cwd is the one git looked for. Grantable only where its
 * directory is a deny anchor the task stands in (the workspace root); one
 * outside the workspace, or a worktree's `.git` file, whose data lies
 * outside, is walled on purpose.
 */
function hiddenGitHint(
  cwd: string,
  granted: readonly string[],
  walled: readonly string[],
  within: string,
): { dir: string; hint: SandboxViolation } | undefined {
  let dir = toRealPath(cwd)
  let st = lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })
  while (st === undefined && path.dirname(dir) !== dir) {
    dir = path.dirname(dir)
    st = lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })
  }
  const git = path.join(dir, '.git')
  if (st === undefined || readableUnder(git, granted)) return undefined
  const said = `vx: git found no repository: the sandbox hides ${git}, and its probe is not reported.`
  const grantable = st.isDirectory() && walled.some((w) => toRealPath(w) === dir)
  return {
    dir: git,
    hint: {
      timestamp: new Date(),
      hint: true,
      line: grantable
        ? `${said} Grant it: \`allow: { read: [${jsString(path.relative(toRealPath(within), git))}] }\`.`
        : `${said} Its data lies outside the workspace, walled on purpose, so vx suggests no grant.`,
    },
  }
}

/**
 * An output line saying a connection was refused (Node's `ECONNREFUSED`,
 * a browser's `ERR_CONNECTION_REFUSED`, curl's "Couldn't connect" or,
 * since 8.7, "Could not connect"), and the loopback ports it names
 * (`refusedLoopbackHint`).
 */
const REFUSED =
  /ECONNREFUSED|ERR_CONNECTION_REFUSED|Connection refused|Could(?:n't| not) connect to server/i

const LOOPBACK_PORT = /(?:localhost|127\.0\.0\.1|\[::1\]|::1)(?::| port )(\d{1,5})\b/gi

/**
 * The hint for a failed task refused on a loopback port a process on the
 * host listens on. On Linux a sandboxed task has a loopback of its own, so
 * a client dialling a dependency's port there got a bare `ECONNREFUSED`
 * and no word of the grant that relays it (2026-11-12). Only a port the
 * host listens on, on loopback or every address, and one not granted
 * already (`granted`: the task's `network` ports and its own `localBinding`).
 */
function refusedLoopbackHint(
  lines: readonly string[],
  granted: readonly number[],
): SandboxViolation | undefined {
  const named = new Set<number>()
  for (const line of lines) {
    if (!REFUSED.test(line)) continue
    for (const m of line.matchAll(LOOPBACK_PORT)) {
      const port = Number(m[1])
      if (port > 0 && port < 65536 && !granted.includes(port)) named.add(port)
    }
  }
  if (named.size === 0 || !procfsIsOwn()) return undefined
  const listening = hostLoopbackListeners()
  const ports = [...named].filter((p) => listening.has(p))
  if (ports.length === 0) return undefined
  const grants = ports.map((p) => `'localhost:${p}'`).join(', ')
  return {
    timestamp: new Date(),
    hint: true,
    line:
      `vx: the task was refused on localhost port${ports.length === 1 ? '' : 's'} ` +
      `${ports.join(', ')}, which a process on this machine listens on: a sandboxed task has ` +
      `a loopback of its own. Grant ${ports.length === 1 ? 'it' : 'them'}: ` +
      `\`allow: { network: [${grants}] }\`.`,
  }
}

/**
 * Linux blocks `socket(AF_UNIX)` unless `allow.unixSockets` grants it, and
 * the block is traced nowhere: the task's client says `Operation not
 * permitted` (socat `socket(1, 1, 0)`, Docker `dial unix …: socket`,
 * Python `PermissionError` under `socket.py`), and the one hint left was
 * the working directory's, which changed nothing. Named only when the
 * output pairs that refusal with a socket; the path, when the client names
 * one, is the grant (Linux allows any path once one is granted).
 */
function refusedUnixSocketHint(lines: readonly string[]): SandboxViolation | undefined {
  const at = lines.findIndex((l, i) => {
    if (!/operation not permitted/i.test(l)) return false
    const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
    return /\bsocket\b|AF_UNIX|UNIX-CONNECT|dial unix/i.test(near)
  })
  if (at < 0) return undefined
  const sock = lines
    .slice(Math.max(0, at - 3), at + 1)
    .join('\n')
    .match(/(?:unix|UNIX-CONNECT:|connect\(')\s*(\/[^\s:'"),]+)/i)?.[1]
  const grant = sock === undefined ? 'true' : `[${JSON.stringify(sock)}]`
  return {
    timestamp: new Date(),
    hint: true,
    line:
      'vx: the task was refused a unix socket: this sandbox blocks them unless granted. ' +
      `If it needs one, grant it: \`allow: { unixSockets: ${grant} }\`.`,
  }
}

/** The TCP ports the host listens on at a loopback address or every address. */
function hostLoopbackListeners(): Set<number> {
  const reachable = new Set([
    '0100007F',
    '00000000',
    '00000000000000000000000001000000',
    '00000000000000000000000000000000',
    '0000000000000000FFFF00000100007F',
  ])
  const ports = new Set<number>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let table: string
    try {
      table = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of table.split('\n')) {
      const f = line.trim().split(/\s+/)
      if (f[3] !== '0A' || f[1] === undefined) continue
      const [addr, port] = f[1].split(':')
      if (reachable.has(addr!)) ports.add(Number.parseInt(port!, 16))
    }
  }
  return ports
}

/** An output line that may name a file its tool found missing (`statedHiddenHint`). */
const NOT_FOUND =
  /does not exist|not found|no such file|cannot find|can't find|could not find|no makefile found|no rule to make target|ENOENT|missing/i

/** The names GNU make looks for, in its order. */
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile']

/**
 * The hint for a failed task whose last output calls missing a path the
 * sandbox hides and the host has. A tool that stats before it opens (tsc's
 * `-p tsconfig.json`: "TS5058: The specified path does not exist") leaves
 * no record: strace does not stop on the stat family (`TRACED_CALLS`), so
 * the task failed with no violation and no fix. Each word of those lines
 * is asked of the host only on a failure; one already named is skipped.
 */
function statedHiddenHint(
  lines: readonly string[],
  cwd: string,
  granted: readonly string[],
  declared: readonly string[],
  walled: readonly string[],
  within: string,
  named: readonly (string | undefined)[],
  key: KeyScope | undefined,
): SandboxViolation | undefined {
  const deny = walled.map(toRealPath)
  const grants = granted.map(toRealPath)
  const seen = new Set<string>()
  const found: string[] = []
  for (const line of lines) {
    const words = line.split(/[\s'"`,:()]+/)
    // make names no file when it found none: the ones it looks for.
    if (/no makefile found/i.test(line)) words.push(...MAKEFILES)
    for (const word of words) {
      const w = word.replace(/\.+$/, '')
      if (w === '' || w.startsWith('-') || w.length > 4096) continue
      const abs = path.resolve(cwd, w)
      if (seen.has(abs)) continue
      seen.add(abs)
      if (!lstatSync(abs, { throwIfNoEntry: false })) continue
      const target = toRealPath(abs)
      // A granted target behind a link the sandbox does not hold is hidden
      // all the same: the grant is the directory holding the link.
      const via = target === abs ? undefined : hiddenLink(abs, target, new Set(grants), deny)
      const real = via ?? target
      // A directory holding a grant is listable (bwrap builds the path to
      // the bind): cargo names its cwd in "could not find `Cargo.toml`".
      if (
        via === undefined &&
        (!deny.some((d) => atOrUnder(real, d)) || readableUnder(real, grants))
      )
        continue
      if (named.some((n) => n !== undefined && atOrUnder(real, n))) continue
      if (!found.includes(real)) found.push(real)
    }
  }
  if (found.length === 0) return undefined
  const project = toRealPath(within)
  const grantable = found.find((p) => !deny.some((w) => atOrUnder(p, w) && !atOrUnder(project, w)))
  // A sandbox that declares no read in its project (`sandbox: {}`) hides
  // every file there: one grant per failure is a round per file.
  const whole =
    grantable !== undefined &&
    grantable !== project &&
    atOrUnder(grantable, project) &&
    !declared.some((g) => atOrUnder(toRealPath(g), project))
      ? " (or its whole project, `read: ['.']`)"
      : ''
  const said =
    `vx: the task failed naming paths the sandbox hides that exist on this machine: ` +
    `${found.slice(0, 5).join(', ')}${found.length > 5 ? ` and ${found.length - 5} more` : ''}. ` +
    `A stat is not traced on Linux, so no violation names them.`
  return {
    timestamp: new Date(),
    hint: true,
    line:
      grantable === undefined
        ? `${said} They are walled on purpose, so vx suggests no grant for them.`
        : `${said} If the task reads one, grant it, e.g. ` +
          `\`allow: { read: [${jsString(grantSpelling(grantable, walled, within))}] }\`${whole}` +
          `${keyEntryHint(grantable, within, key)}.`,
  }
}

/** A cached task's key scope: the workspace root, and the projects nested in its own. */
interface KeyScope {
  root: string
  nested: readonly string[]
}

const keyOf = (args: Pick<SandboxedRunArgs, 'keyRoot' | 'keyNested'>): KeyScope | undefined =>
  args.keyRoot === undefined ? undefined : { root: args.keyRoot, nested: args.keyNested ?? [] }

/**
 * For a cached task (`key`), the input entry that keys a path a hint
 * grants: the grant alone, applied as given, read it unkeyed, and an edit
 * there replayed the old bytes (`replace … => ../golib` in a cached `go
 * build`). The project's own `inputs.files` in it, else
 * `inputs.workspaceFiles`, which a path in a nested project takes too:
 * `vx lock` refuses a `files` glob into one. A directory whole. Nothing
 * outside the workspace: no glob can name it.
 */
function keyEntryHint(p: string, within: string, key: KeyScope | undefined): string {
  if (key === undefined) return ''
  const root = toRealPath(key.root)
  if (!atOrUnder(p, root)) return ''
  const project = toRealPath(within)
  const own = atOrUnder(p, project) && !key.nested.some((d) => atOrUnder(p, toRealPath(d)))
  const [field, base] = own ? ['files', project] : ['workspaceFiles', root]
  const rel = relPosix(base, p)
  const dir = statSync(p, { throwIfNoEntry: false })?.isDirectory() === true
  const glob = rel === '' ? '**' : dir ? `${taskGlobOf(rel)}/**` : taskGlobOf(rel)
  return `, and, if the output depends on it, key it: \`inputs: { ${field}: [${jsString(glob)}] }\``
}

/**
 * A path as a JS string literal a config can take: a quote or a backslash
 * in it is escaped, so the escape in a key entry `\!cfg` survives being pasted.
 */
export const jsString = (p: string): string =>
  p.includes("'") ? JSON.stringify(p) : `'${p.replaceAll('\\', '\\\\')}'`

/** The host's shared temp directories, canonical: what a fixed temp path in a tool names. */
function hostTempRoots(): string[] {
  return [...new Set(['/tmp', '/var/tmp', os.tmpdir()].map(toRealPath))]
}

/**
 * The hint for reads the wall hid outside the project. A path under a
 * deny entry other than the ones holding the project (a credential store
 * or its link's target, vx's own store, the repository's git data outside
 * the workspace) is walled on purpose and never the suggested grant: an
 * agent applies a suggestion as given, and `cat ~/.npmrc` was told to
 * grant `../../home/.npmrc`. For a cached task (`keyRoot`) a grant in the
 * workspace is named for `inputs.workspaceFiles` too: applied alone, an
 * edit there replayed the old bytes.
 */
function hiddenReadsHint(
  paths: readonly string[],
  walled: readonly string[],
  within: string,
  key: KeyScope | undefined,
): SandboxViolation {
  const shown = paths.slice(0, 5).join(', ')
  const more = paths.length > 5 ? ` and ${paths.length - 5} more` : ''
  const project = toRealPath(within)
  const deny = walled.map(toRealPath)
  const grantable = paths.find((p) => !deny.some((w) => atOrUnder(p, w) && !atOrUnder(project, w)))
  const said =
    `vx: the sandbox hid paths outside the project that exist on this machine, which are ` +
    `not reported as violations: ${shown}${more}.`
  return {
    timestamp: new Date(),
    hint: true,
    line:
      grantable === undefined
        ? `${said} They are walled on purpose, so vx suggests no grant for them.`
        : `${said} If the task reads one, grant it, e.g. ` +
          `\`allow: { read: [${jsString(grantSpelling(grantable, walled, within))}] }\`` +
          `${keyEntryHint(grantable, within, key)}.`,
  }
}

/**
 * A path as a committed config spells its grant: from the project inside
 * the walls (the absolute path holds only on the machine that printed
 * it), `~/…` under home, else absolute.
 */
function grantSpelling(p: string, walled: readonly string[], within: string): string {
  const home = toRealPath(os.homedir())
  return walled.some((w) => atOrUnder(p, toRealPath(w)))
    ? path.relative(toRealPath(within), p) || '.'
    : atOrUnder(p, home)
      ? `~${p.slice(home.length)}`
      : p
}

/**
 * Is `dir` inside a path the sandbox granted for reading? bwrap binds and
 * seatbelt rules are both prefix-based, so a grant covers the subtree.
 */
export function readableUnder(dir: string, granted: readonly string[]): boolean {
  const target = toRealPath(dir)
  return granted.some((p) => {
    const g = toRealPath(p)
    // On Linux a grant INSIDE the cwd makes the cwd listable too: bwrap
    // builds the path to the bind. A root's `read: ['.']` is bound as its
    // children around the walls (`wallOff`), so every failing root task
    // was told its cwd was unreadable while it listed it (B-20). Seatbelt
    // grants no parent, so on macOS the cwd itself must be covered.
    return atOrUnder(target, g) || (process.platform === 'linux' && atOrUnder(g, target))
  })
}
