// The sandbox half of an `ExecuteRequest`: what a task may read and write,
// where denials are reported, and the filesystem groundwork a bind needs
// (bwrap cannot bind a path that does not exist). Shared by the cached path
// (through the executor) and the persistent path (spawned in execute-task).

import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ExecConfig } from '../config.js'
import {
  bindableWrites,
  initSandbox,
  resetSandbox,
  probeSandbox,
  punchWalls,
  resolveSandboxConfig,
  type ResolvedSandboxConfig,
  thrownReason,
  toRealPath,
  type ExecuteRequest,
  isMountableLiteral,
  atOrUnder,
  type SandboxViolation,
} from '../exec/index.js'
import type { TaskNode } from '../graph/index.js'
import { grantPrefix, relPosix, UserError } from '../util/index.js'
import { WORKSPACE_FINGERPRINT_FILES } from '../workspace/index.js'

/**
 * Arm the sandbox runtime for a run, lazily: only when at least one task
 * opts in through its `sandbox: {...}` block. A task that needs sandboxing
 * on a platform without one is a hard error, so it never silently runs
 * unsandboxed. Returns whether the runtime was armed — the run resets it
 * at the end (`resetSandbox`), or the next run inits on top of stale
 * proxy state.
 */
export interface SandboxArmer {
  /**
   * Probe availability and start the runtime, once; every later call
   * shares the same promise. Throws the `sandbox not available` UserError
   * when the platform cannot host it.
   */
  arm(): Promise<void>
  /** True once `arm()` has completed — the run then owns a runtime to reset. */
  readonly armed: boolean
}

/**
 * What SRT's run-wide `initialize()` is armed with, folded from every
 * sandboxed task in the graph — or `null` when the run has none.
 *
 * Split out of `prepareSandbox` (pure motion) because it is the only
 * part of the arming that can be READ without starting a sandbox: the
 * call itself is observable solely through a live runtime, so the values
 * it carries had no witness of any kind and three separate widenings of
 * them survived a whole-suite mutation sweep (item 537).
 */
export interface SandboxRunUnion {
  /** Domains the run's filtering proxy will accept, in declaration order. */
  domains: string[]
  /**
   * Domains the proxy refuses, whichever task asks: every task's
   * `deny.network`. The proxy is the run's, so a deny is too (B-21).
   */
  deniedDomains: string[]
  /** Whether SRT's all-or-nothing `socket(AF_UNIX)` filter is lifted for the run. */
  unixSockets: boolean
  /** Whether any task grants `gitConfig`, which SRT reads run-wide and vx sets per wrap (B-41). */
  gitConfig: boolean
  /** Whether EVERY sandboxed task accepts the weaker nested profile. */
  weakerNested: boolean
}

export function sandboxRunUnion(nodes: Iterable<TaskNode>): SandboxRunUnion | null {
  const sandboxed = [...nodes].filter((n) => n.config.exec?.sandbox !== undefined)
  if (sandboxed.length === 0) return null
  const weakerNested = sandboxed.every((n) => n.config.exec?.sandbox?.weakerWhenNested === true)
  const domains = new Set<string>()
  const denied = new Set<string>()
  let unixSockets = false
  let gitConfig = false
  for (const n of sandboxed) {
    const allow = n.config.exec?.sandbox?.allow
    const net = allow?.network
    // `network: true` adds nothing to the union: folded in as `*` it would
    // widen the allowlist every OTHER task in the run is filtered against.
    // It does not skip the proxy either, so it reaches only the domains
    // some task of the run lists (schema.md § network is per-RUN).
    if (Array.isArray(net)) for (const d of net) domains.add(d)
    for (const d of n.config.exec?.sandbox?.deny?.network ?? []) denied.add(d)
    const sockets = allow?.unixSockets
    if (sockets === true || (Array.isArray(sockets) && sockets.length > 0)) unixSockets = true
    const lb = allow?.localBinding
    if (Array.isArray(lb) && lb.length > 0 && process.platform === 'linux') unixSockets = true
    if (allow?.gitConfig === true) gitConfig = true
  }
  return { domains: [...domains], deniedDomains: [...denied], unixSockets, gitConfig, weakerNested }
}

/**
 * Prepare the sandbox for a run WITHOUT starting it. Starting is
 * `arm()`, and it happens on the first task that actually executes inside
 * a sandbox — not up front. Up front, every run of a sandboxed workspace
 * paid the probe (a sandboxed `true` through the runtime, ~300–400 ms on
 * Linux, the runtime module's own load included) even when every task was
 * a cache hit and nothing executed; measured 2026-09-10 on this repo's
 * own warm gate: `classify + probe` 288 ms of a 798 ms run. A hit needs
 * no sandbox, so a hit pays nothing. `run()` arms early only when a
 * sandboxed task is sure to execute (C-76).
 *
 * The domain union is computed here from every sandboxed node, because
 * SRT runs ONE filtering proxy per run and checks every request against
 * the allowlist given to `initialize()` — never the per-call one
 * (`sandbox-manager.js`, 0.0.75 and 0.0.76). A task that declares no domains still
 * reaches nothing: its profile is not given the proxy's port at all.
 * The unix-socket allowance is per run the same way: SRT's Linux seccomp
 * filter on `socket(AF_UNIX)` is all-or-nothing and read at
 * `initialize()`, so a task declaring `unixSockets`, or a `localBinding`
 * port list (its bridge is a unix socket the task's side creates), lifts
 * it for the run. macOS keeps per-task precision through vx's own rules.
 */
export function prepareSandbox(nodes: Iterable<TaskNode>): SandboxArmer | null {
  const union = sandboxRunUnion(nodes)
  if (union === null) return null
  const { domains, deniedDomains, unixSockets, gitConfig, weakerNested } = union
  let pending: Promise<void> | undefined
  let armed = false
  return {
    get armed() {
      return armed
    },
    arm() {
      pending ??= (async () => {
        try {
          const avail = await probeSandbox({ weakerNested })
          if (!avail.available) throw new UserError(`sandbox not available: ${avail.reason}`)
          await initSandbox({
            allowedDomains: domains,
            deniedDomains,
            ...(unixSockets ? { allowAllUnixSockets: true } : {}),
            ...(gitConfig ? { gitConfig: true } : {}),
          })
        } catch (err) {
          // The Linux probe brings the runtime up, and only an armed run
          // resets it: a refusal past the probe left its proxy holding the
          // process open, and the run hung after its summary (2026-10-02).
          await resetSandbox().catch(() => {})
          // A throw from the runtime itself (its bridge needs socat, which
          // the dependency check does not cover) gets the same one-line
          // verdict as a refused probe, not an internal error with a stack.
          if (err instanceof UserError) throw err
          throw new UserError(`sandbox not available: ${thrownReason(err)}`)
        }
        armed = true
      })()
      return pending
    },
  }
}

/**
 * The sandbox half of an `ExecuteRequest` for one task, shared by the
 * cached path (through the executor) and the persistent path (spawned here).
 *
 * The user's grants derive NOTHING from `cache` (owner, 2026-09-05). Those
 * are two different questions: `cache.inputs` says what INVALIDATES the
 * task, `sandbox.allow` says what it may TOUCH. Deriving one from the other
 * coupled them in both directions — a declaration added for caching
 * silently widened the sandbox, and a path the task needed had to be
 * laundered through the cache key to get it. A sandboxed task declares
 * its own reads and writes.
 *
 * `node_modules` is the one grant core still makes: it is where the task's
 * own PATH gets its `.bin` entries, and denying it made the sandbox
 * unusable for anything that imports a dependency (`bun build --compile`
 * died with only `error: An unknown error occurred (Unexpected)`; owner
 * call 2026-09-04). Declaring `cache` may NARROW that grant, never widen
 * anyone's (2026-09-24): `keyed` is the set of project directories the
 * task's key answers for (keyed-projects.ts), and `undefined` for a task
 * with no `cache`, which has no key to be stale.
 */
export async function sandboxRequestFor(
  node: TaskNode,
  sandbox: NonNullable<ExecConfig['sandbox']>,
  workspaceRoot: string,
  keyed: ReadonlySet<string> | undefined,
  /** The projects nested in this one (their dirs): a wall its grants do not reach. */
  nested: readonly string[] = [],
  /**
   * The run's cache directory. `.vx` is walled wherever it is; a
   * `cacheDir` configured inside a project was not, and a task whose write
   * grant covered it could plant artifacts and index rows (L-24).
   */
  cacheDir?: string,
): Promise<SandboxRequest> {
  // The runtime reads a path holding a bracket as a pattern: on Linux it
  // mounts no such write path (B-60); seatbelt's rules compile it as a
  // character class, so vx's own workspace wall matched nothing (B-65).
  // A `*` or `?` is one too, and its grants matched the project's siblings.
  const home = toRealPath(node.projectDir)
  if (/[[\]*?]/.test(home)) {
    throw new UserError(
      `exec.sandbox: ${home} holds [, ], * or ?, which the sandbox runtime reads as a ` +
        `pattern, not a name — rename the directory, or run the task without exec.sandbox`,
    )
  }
  // Bun's realpath throws ENOENT on a path holding a backslash, and SRT
  // mounts no path it cannot resolve: the task saw no project and ran in
  // $HOME.
  if (process.platform === 'linux' && home.includes('\\')) {
    throw new UserError(
      `exec.sandbox: ${home} holds a backslash, which the Linux sandbox cannot resolve, so ` +
        `it mounts none of the project — rename the directory, or run the task without exec.sandbox`,
    )
  }
  const depDirs = [
    path.join(node.projectDir, 'node_modules'),
    path.join(workspaceRoot, 'node_modules'),
  ]
  // A workspace dependency is a SYMLINK in `node_modules` pointing at a
  // sibling project, so granting `node_modules` grants a link whose
  // target is outside it. That target is a dependency, not a reach-out:
  // no project config should have to name a sibling to import what its
  // own `package.json` depends on (owner, 2026-09-05) — when the key
  // moves with it.
  const links = await linkedDeps(depDirs, node.projectDir, workspaceRoot, keyed)
  depDirs.push(...links.granted)
  // bwrap cannot --bind a path that does not exist: the bind silently
  // becomes a no-op and writes to it appear to succeed but never land.
  // Pre-create what the task said it will write — after the grants are
  // resolved, which refuses one that leaves the project through a link
  // before anything is created along it (item 1003).
  const walls = [
    ...nested,
    path.join(workspaceRoot, '.git'),
    path.join(workspaceRoot, '.vx'),
    ...(cacheDir !== undefined &&
    toRealPath(cacheDir).startsWith(toRealPath(workspaceRoot) + path.sep)
      ? [cacheDir]
      : []),
  ].map(toRealPath)
  const resolved = resolveSandboxConfig(sandbox, node.projectDir, walls)
  // Made before the walls judge the binds: a directory grant naming nothing
  // yet (`dist/`, `dist/**`) was judged as a file, its bind its parent, and
  // a root project's was refused for `.git`.
  const placeholders = await prepareOutputsForBind(node.projectDir, sandbox.allow?.write ?? [])
  let config: ResolvedSandboxConfig
  try {
    config = wallOff(resolved, workspaceRoot, walls)
  } catch (err) {
    await sweepPlaceholders(placeholders)
    throw err
  }
  const request: NonNullable<ExecuteRequest['sandbox']> = {
    // Only what the task declared, plus node_modules. Write paths are
    // readable too: a task that writes `dist/x` expects to read it back
    // (`tsc --incremental` re-reads .tsbuildinfo).
    baseAllowRead: depDirs,
    // Enforcement anchors at the WORKSPACE ROOT: a task may not leave
    // its project, so every sibling and every root file is denied.
    // Reporting is a different question — see `reportWithin` below.
    // On macOS the walls are denied too: seatbelt does not mount, so the
    // punch cannot apply, and SRT emits a deny strictly inside a literal
    // read grant AFTER the grant, where it wins (`lateReadDenyFilters`,
    // 0.0.76). A grant naming a wall is not strictly outside it and wins.
    // Without it a root task's `read: ['.']` read its nested projects under
    // seatbelt (B-4).
    // The host's credential stores are denied too: the rest of home stays
    // readable (tools need `~/.cache`), but a dependency the task runs
    // could copy a key into an output the cache shares (L-41).
    baseDenyRead: [
      ...(process.platform === 'darwin' ? [workspaceRoot, ...walls] : [workspaceRoot]),
      ...(await credentialStores(workspaceRoot, config.allowWrite)),
    ],
    // …but only denials INSIDE the project are worth reporting. A task
    // bumping into the wall is the sandbox working, not a finding: the
    // walk `bun build --compile` makes from `/` down to its cwd lists
    // every directory on the way (traced 2026-09-05) and no config can
    // declare that away. What DOES matter is an undeclared touch of the
    // project's own files — that is the one that breaks the cache key,
    // because the key folds this project's inputs.
    reportWithin: node.projectDir,
    // …and of a dependency withheld above: the task reached for it
    // through its own `node_modules`, and that read is the stale hit the
    // withholding exists to stop, not the wall.
    reportLinked: links.withheld.map((w) => w.dir),
    config,
  }
  return { sandbox: request, placeholders, withheld: links.withheld }
}

/**
 * The sandbox half of the request, plus the empty files vx created so a
 * literal write grant had something to bind (`placeholders`). They are
 * vx's, not the task's, until the task writes them: `sweepPlaceholders`
 * takes back the ones it never touched. `withheld` names the linked
 * dependencies a cached task was denied, for the hint a denial under one
 * earns (`withheldLinkLine`).
 */
export interface SandboxRequest {
  sandbox: NonNullable<ExecuteRequest['sandbox']>
  placeholders: Placeholder[]
  withheld: WithheldLink[]
}

/** An empty file vx created for a bind, and its mtime at creation. */
export interface Placeholder {
  path: string
  mtimeMs: number
}

/** A workspace link whose target the task's key does not answer for. */
export interface WithheldLink {
  /** The canonical target, inside the workspace root. */
  dir: string
  /** The name it is installed under (`@x/ui`). */
  name: string
  /** The target and the link, workspace-relative POSIX, for the hint. */
  target: string
  link: string
}

/**
 * Where the workspace links in `dirs` actually point, split into what the
 * task is granted and what it is not.
 *
 * One level deep, plus one level inside a `@scope/` directory — the shape
 * a package manager writes. Anything already inside a granted directory
 * is dropped; what is left is a sibling project's real path.
 *
 * A link to the task's OWN project, or to a directory holding it, is
 * dropped too: npm and Yarn classic link every workspace package at the
 * root, the task's own included, and granting that target handed the
 * project back whole whatever its `allow.read` said — an undeclared read
 * of its own file ran unreported, and an edit to it was a stale hit.
 *
 * With `keyed` given (a cached task), a target inside the workspace root
 * is granted only when it IS a keyed project's directory; every other one
 * is withheld, since an edit there would not move the key. A target
 * outside the root lies outside the deny anchor, so granting it is a no-op
 * either way. Every side of every comparison is canonical: a target always
 * is, and a directory under a root reached through a link (macOS's `/var`)
 * is not.
 */
async function linkedDeps(
  dirs: readonly string[],
  projectDir: string,
  workspaceRoot: string,
  keyed: ReadonlySet<string> | undefined,
): Promise<{ granted: string[]; withheld: WithheldLink[] }> {
  const [self, root] = await Promise.all([realpath(projectDir), realpath(workspaceRoot)])
  const realDirs = dirs.map(toRealPath)
  const scan = async (dir: string, scope: string): Promise<Array<[string, string, string]>> => {
    const found: Array<[target: string, link: string, name: string]> = []
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        const target = await realpath(full).catch(() => undefined)
        if (
          target !== undefined &&
          !realDirs.some((d) => atOrUnder(target, d)) &&
          !atOrUnder(self, target)
        ) {
          found.push([target, full, scope + e.name])
        }
      } else if (scope === '' && e.isDirectory() && e.name.startsWith('@')) {
        found.push(...(await scan(full, `${e.name}/`)))
      }
    }
    return found
  }
  // Merged in `dirs` order, so the link a hint names is the project's own
  // when both have one.
  const targets = new Map<string, { link: string; name: string }>()
  for (const found of await Promise.all(dirs.map((d) => scan(d, '')))) {
    for (const [target, link, name] of found) {
      if (!targets.has(target)) targets.set(target, { link, name })
    }
  }
  if (keyed === undefined) return { granted: [...targets.keys()], withheld: [] }
  const keyedDirs = new Set(await Promise.all([...keyed].map((d) => realpath(d))))
  const granted: string[] = []
  const withheld: WithheldLink[] = []
  for (const [target, { link, name }] of targets) {
    if (!atOrUnder(target, root) || keyedDirs.has(target)) granted.push(target)
    else
      withheld.push({
        dir: target,
        name,
        target: relPosix(root, target),
        link: relPosix(workspaceRoot, link),
      })
  }
  return { granted, withheld }
}

/**
 * The line a task denied a withheld dependency gets beside the denial:
 * what it reached, through which link, and the two ways to make the key
 * answer for it. Added only when a violation already sits under the
 * target, so it never reddens a pass.
 */
export function withheldLinkLine(taskId: string, w: WithheldLink): string {
  return (
    `vx: ${taskId} read \`${w.target}\` through \`${w.link}\`, and its key folds no task of ` +
    `${w.name}, so an edit there would not re-run it. Add a \`dependsOn\` edge that ` +
    `reaches one (\`^build\` where ${w.name}#build keys its sources, or a \`source\` task: ` +
    `\`${w.name}#source\`), or grant and key the files yourself (\`allow.read\` plus ` +
    `\`cache.inputs.workspaceFiles\`).`
  )
}

/** The withheld dependencies a reported denial lies under: each earns its hint. */
export function reachedWithheld(
  withheld: readonly WithheldLink[],
  violations: readonly SandboxViolation[],
): WithheldLink[] {
  return withheld.filter((w) =>
    violations.some((v) => v.path !== undefined && atOrUnder(v.path, w.dir)),
  )
}

/**
 * Ensure each declared write path exists on the host as either an empty
 * file (a literal path) or a directory (a glob's static prefix, or a
 * literal ending in `/`) so bwrap's --bind can find a real fs entry to
 * mount. Without this, writes inside the sandbox to a non-existent
 * allowWrite path silently disappear (bwrap creates a tmpfs that
 * evaporates on exit).
 *
 * A literal that names nothing yet is a FILE — `dist/vx` for `bun build
 * --outfile dist/vx` — and the task that meant a directory (`write:
 * ['dist']`, then `mkdir -p dist`) met "File exists" from its own tool,
 * with the empty file left behind for every later run to meet again
 * (its `dist/**` clean matches nothing under a file; 2026-09-16). So a
 * directory is spelled `dist/`, and the files created here are returned
 * so the caller can take back the ones the task never wrote.
 *
 * `cleanOutputs` ran just before this in the cache-enabled path, so
 * we know any stale content was wiped; what's left is to materialize
 * the empty skeleton.
 */
async function prepareOutputsForBind(
  projectDir: string,
  outputs: readonly string[],
): Promise<Placeholder[]> {
  const placeholders: Placeholder[] = []
  for (const g of outputs) {
    const hasWildcard = !isMountableLiteral(g)
    // A grant OUTSIDE the project is the user's own path — never joined
    // onto the project dir, which would create a literal `~` there. Its
    // directory is still created when the grant names one — a glob's
    // static prefix, or a literal spelled `dir/` — because bwrap cannot
    // bind a directory that does not exist: `~/.bun/install/cache/**` on a
    // runner that has never populated it silently granted nothing, and the
    // task failed with the tool's own confusing message (`bun build
    // --compile` reported a network error for an unwritable cache;
    // 2026-09-05). The `dir/` spelling was skipped until 2026-09-29.
    if (path.isAbsolute(g) || g.startsWith('~')) {
      if (!hasWildcard && !g.endsWith('/')) continue
      const abs = expandHome(hasWildcard ? grantPrefix(g) : g)
      await mkdir(abs, { recursive: true }).catch(() => undefined)
      continue
    }
    const dir = hasWildcard || g.endsWith('/')
    const abs = path.join(projectDir, hasWildcard ? grantPrefix(g) : g)
    try {
      if (dir) {
        await mkdir(abs, { recursive: true })
        continue
      }
      // Whatever is already there is what the task meant — a grant on the
      // project dir itself is a directory, and touching it as a file is
      // an EISDIR, not a missing bind. `lstat`, and an exclusive create: a
      // dangling link at the grant made vx, unsandboxed, create the empty
      // file at the link's target in another project (item 1003).
      if (await lstat(abs).catch(() => undefined)) continue
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, '', { flag: 'wx' })
      placeholders.push({ path: abs, mtimeMs: (await lstat(abs)).mtimeMs })
    } catch (err) {
      await sweepPlaceholders(placeholders)
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTDIR') throw err
      // A file stands where the grant needs a directory: `out.txt/` over a
      // file, or `a.txt/x/*.js`. It reached the user as an internal error.
      const blocker = await fileOnPath(projectDir, dir ? abs : path.dirname(abs))
      throw new UserError(
        `exec.sandbox.allow.write: "${g}" needs a directory at ${blocker}, and a file is ` +
          `there — remove the file, or grant a path beside it`,
      )
    }
  }
  return placeholders
}

/** The first path from `from` down to `to` that exists and is not a directory. */
async function fileOnPath(from: string, to: string): Promise<string> {
  let at = from
  for (const part of path.relative(from, to).split(path.sep)) {
    at = path.join(at, part)
    const st = await lstat(at).catch(() => undefined)
    if (st !== undefined && !st.isDirectory()) return at
  }
  return to
}

/**
 * The walls a project's grants stop at: its nested projects, the
 * repository and vx's directory (item 1010). A read grant around one is
 * punched (`punchWalls`); a write grant whose bind would hold one — a file
 * grant binds its directory on Linux, so `write: ['out.txt']` in a root
 * project bound the whole workspace writable, `.git` included — is
 * refused, as there is no writable bind that leaves a wall out. A glob's
 * hits already stop at the walls (`resolveSandboxConfig` takes them).
 */
function wallOff(
  config: ResolvedSandboxConfig,
  workspaceRoot: string,
  walls: readonly string[],
): ResolvedSandboxConfig {
  const home = toRealPath(workspaceRoot)
  for (const bind of bindableWrites(config.allowWrite)) {
    // A bind outside the workspace is the user's own path (`/tmp/x`,
    // `~/.cache/y`), spelled there on purpose; only one inside is judged.
    if (!atOrUnder(bind, home)) continue
    const wall = walls.find((w) => atOrUnder(w, bind))
    if (wall === undefined) continue
    throw new UserError(
      `exec.sandbox.allow.write: the grant binding ${bind} would make ${wall} writable — another ` +
        `project's directory, the repository or vx's own. A file grant binds its directory; ` +
        `grant a directory of the task's own instead, such as "dist/".`,
    )
  }
  return { ...config, allowRead: config.allowRead.flatMap((r) => punchWalls(r, walls)) }
}

/**
 * Remove the placeholder files the task never wrote — still empty, mtime
 * untouched — and return their paths. What the task wrote is its output
 * and stays; what it did not is vx's own litter, and litter under a
 * declared output would be archived as the task's (an empty `dist/vx`
 * saved as a build) or, as a file where the task wanted a directory,
 * would fail every later run the same way.
 */
export async function sweepPlaceholders(placeholders: readonly Placeholder[]): Promise<string[]> {
  const untouched: string[] = []
  for (const p of placeholders) {
    // `lstat`: a link the task put in the placeholder's place is its
    // output, never vx's litter to remove (item 1003).
    const st = await lstat(p.path).catch(() => undefined)
    if (st === undefined || !st.isFile() || st.size !== 0 || st.mtimeMs !== p.mtimeMs) continue
    await rm(p.path, { force: true })
    untouched.push(p.path)
  }
  return untouched
}

/**
 * One sweep, however many askers, each getting the SAME list.
 *
 * A failed persistent task has two askers — the child's exit handler and
 * the readiness failure that reports the hint — and a second
 * `sweepPlaceholders` cannot serve the later one: the first one's `rm`
 * already happened, so it finds nothing and names nothing. Collecting
 * both lists and unioning them does not close it either, because a sweep
 * still between its `rm` and its return has published nothing yet, and
 * the union is then empty on both sides. Sharing the one promise is what
 * makes the answer independent of who asked first.
 */
export function placeholderSweeper(placeholders: readonly Placeholder[]): () => Promise<string[]> {
  let once: Promise<string[]> | undefined
  return () => (once ??= sweepPlaceholders(placeholders))
}

/**
 * The line a failed task gets for a placeholder it never wrote. Not a
 * diagnosis — the task may have died before its first write — but the
 * one clue to the trap: a grant that meant a directory is bound as a
 * file, and the task's own `mkdir` says only "File exists" (or "Not a
 * directory" for a path inside it, B-96). Added when
 * the task already failed and the sandbox reported nothing else, so it
 * never reddens a pass and never buries a real denial.
 */
export function untouchedPlaceholderLine(projectDir: string, placeholder: string): string {
  const rel = relPosix(projectDir, placeholder)
  return (
    `vx: the sandbox write grant \`${rel}\` named nothing on disk, so vx bound it as an empty ` +
    `file, which the task never wrote (removed again). If the task creates a directory there ` +
    `("File exists" or "Not a directory" from its own mkdir), spell the grant \`${rel}/\` — a literal without the ` +
    `slash is a file.`
  )
}

/**
 * Where tools keep credentials under the user's home. A sandboxed task
 * reads none of them unless its `allow.read` names one (a publish task's
 * `~/.npmrc`).
 */
const CREDENTIAL_STORES = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.config/gcloud',
  '.config/gh',
  '.docker/config.json',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.yarnrc.yml',
  '.pypirc',
  // Registry and service tokens of the same kind: Bun's global bunfig
  // (`[install.scopes]` tokens) at either of its homes, Cargo's, RubyGems'.
  '.bunfig.toml',
  '.config/.bunfig.toml',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.gem/credentials',
  '.config/hub',
  '.config/containers/auth.json',
  '.terraform.d/credentials.tfrc.json',
  '.vault-token',
  '.pgpass',
]

/** The stores present on this host, learned once per home. */
let presentStores: { home: string; paths: string[] } | undefined

/**
 * The credential stores to deny, less any that holds the workspace, and
 * punched around the task's write grants: a grant names a store as a read
 * does. Denied whole, the store's mask landed on the grant's bind (a file
 * grant binds its directory on Linux), so `write: ['~/.npmrc']` wrote to
 * /dev/null with exit 0, and `~/.aws/config` left `~/.aws/credentials`
 * readable. A grant above a store does not name it, so it stays denied.
 */
async function credentialStores(
  workspaceRoot: string,
  writes: readonly string[],
): Promise<string[]> {
  const home = homedir()
  if (presentStores?.home !== home) {
    presentStores = {
      home,
      paths: CREDENTIAL_STORES.map((rel) => path.join(home, rel)).filter((p) => existsSync(p)),
    }
  }
  const stores = presentStores.paths.filter(
    (p) => workspaceRoot !== p && !workspaceRoot.startsWith(p + path.sep),
  )
  return (await Promise.all(stores.map((p) => denyAround(toRealPath(p), writes)))).flat()
}

/** `dir` denied, or its entries no write grant lies under or at when one is inside it. */
async function denyAround(dir: string, writes: readonly string[]): Promise<string[]> {
  const inside = writes.filter((w) => atOrUnder(w, dir))
  if (inside.length === 0) return [dir]
  if (inside.includes(dir)) return []
  const entries = await readdir(dir).catch(() => [])
  return (await Promise.all(entries.map((e) => denyAround(path.join(dir, e), inside)))).flat()
}

/** `~/x` against the user's home; anything else unchanged. */
function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p
}

/** Where a command may have written: nothing a key reads, its own project, or any project. */
export type WriteReach = 'none' | 'project' | 'workspace'

/**
 * Where a task that ran a command may have written files no declaration
 * names — the files whose run-start facts (the git snapshot, its index
 * OIDs, the `package.json` digest) a later key must not reuse (item 743).
 *
 * A cached task declares its outputs and is held to them. A task with no
 * `cache` block can declare none, so it may have written anywhere
 * `commandWriteReach` says. An unsandboxed write into another project is
 * out of contract, as it is for a cached task.
 */
export function undeclaredWriteReach(node: TaskNode, workspaceRoot: string): WriteReach {
  if (node.config.cache !== undefined) return 'none'
  return commandWriteReach(node, workspaceRoot)
}

/**
 * Where a task's command may write at all: anywhere in its own project
 * (`'project'`), unless a sandbox bounds it — no write grant writes nothing
 * a key reads (`'none'`), and a grant that leaves the project for elsewhere
 * in the workspace reaches every project (`'workspace'`). A grant outside
 * the workspace reaches no input. A cached task's reach is where it may
 * rewrite its own inputs in place (a formatter), which the stability gate
 * reads (stable-keys.ts).
 */
export function commandWriteReach(node: TaskNode, workspaceRoot: string): WriteReach {
  const exec = node.config.exec
  if (exec === undefined) return 'none'
  if (exec.sandbox === undefined) return 'project'
  let reach: 'none' | 'project' = 'none'
  for (const grant of exec.sandbox.allow?.write ?? []) {
    const abs = path.resolve(node.projectDir, expandHome(grantPrefix(grant)))
    if (atOrUnder(abs, node.projectDir)) reach = 'project'
    else if (atOrUnder(abs, workspaceRoot) || atOrUnder(workspaceRoot, abs)) return 'workspace'
  }
  return reach
}

/**
 * May this task's command rewrite a file the workspace fingerprint folds
 * (a lockfile, `pnpm-workspace.yaml`)? Those sit at the workspace root, so
 * an unsandboxed task may only when the root is its own project (`pnpm
 * install` without `--frozen-lockfile` in a root task); a sandboxed one
 * when a write grant covers one. Anyone else writing there crosses a
 * project boundary, out of contract.
 */
export function mayWriteFingerprint(node: TaskNode, workspaceRoot: string): boolean {
  const exec = node.config.exec
  if (exec === undefined) return false
  if (exec.sandbox === undefined) return node.projectDir === workspaceRoot
  for (const grant of exec.sandbox.allow?.write ?? []) {
    const abs = path.resolve(node.projectDir, expandHome(grantPrefix(grant)))
    for (const f of WORKSPACE_FINGERPRINT_FILES) {
      if (atOrUnder(path.join(workspaceRoot, f), abs)) return true
    }
  }
  return false
}
