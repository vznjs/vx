// The sandbox half of an `ExecuteRequest`: what a task may read and write,
// where denials are reported, and the filesystem groundwork a bind needs
// (bwrap cannot bind a path that does not exist). Shared by the cached path
// (through the executor) and the persistent path (spawned in execute-task).

import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ExecConfig } from '../config.js'
import {
  initSandbox,
  probeSandbox,
  resolveSandboxConfig,
  thrownReason,
  type ExecuteRequest,
  isMountableLiteral,
  type SandboxViolation,
} from '../exec/index.js'
import type { TaskNode } from '../graph/index.js'
import { grantPrefix, UserError } from '../util/index.js'
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
 * Prepare the sandbox for a run WITHOUT starting it. Starting is
 * `arm()`, and it happens on the first task that actually executes inside
 * a sandbox — not up front. Up front, every run of a sandboxed workspace
 * paid the probe (a sandboxed `true` through the runtime, ~300–400 ms on
 * Linux, the runtime module's own load included) even when every task was
 * a cache hit and nothing executed; measured 2026-09-10 on this repo's
 * own warm gate: `classify + probe` 288 ms of a 798 ms run. A hit needs
 * no sandbox, so a hit pays nothing.
 *
 * The domain union is computed here from every sandboxed node, because
 * SRT runs ONE filtering proxy per run and checks every request against
 * the allowlist given to `initialize()` — never the per-call one
 * (`sandbox-manager.js` 0.0.75). A task that declares no domains still
 * reaches nothing: its profile is not given the proxy's port at all.
 * The unix-socket allowance is per run the same way: SRT's Linux seccomp
 * filter on `socket(AF_UNIX)` is all-or-nothing and read at
 * `initialize()`, so a task declaring `unixSockets`, or a `localBinding`
 * port list (its bridge is a unix socket the task's side creates), lifts
 * it for the run. macOS keeps per-task precision through vx's own rules.
 */
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
  /** Whether SRT's all-or-nothing `socket(AF_UNIX)` filter is lifted for the run. */
  unixSockets: boolean
  /** Whether EVERY sandboxed task accepts the weaker nested profile. */
  weakerNested: boolean
}

export function sandboxRunUnion(nodes: Iterable<TaskNode>): SandboxRunUnion | null {
  const sandboxed = [...nodes].filter((n) => n.config.exec?.sandbox !== undefined)
  if (sandboxed.length === 0) return null
  const weakerNested = sandboxed.every((n) => n.config.exec?.sandbox?.weakerWhenNested === true)
  const domains = new Set<string>()
  let unixSockets = false
  for (const n of sandboxed) {
    const allow = n.config.exec?.sandbox?.allow
    const net = allow?.network
    // `network: true` is deliberately absent from the union: it SKIPS the
    // proxy rather than going through it, so folding it in as `*` would
    // widen the allowlist every OTHER task in the run is filtered against.
    if (Array.isArray(net)) for (const d of net) domains.add(d)
    const sockets = allow?.unixSockets
    if (sockets === true || (Array.isArray(sockets) && sockets.length > 0)) unixSockets = true
    const lb = allow?.localBinding
    if (Array.isArray(lb) && lb.length > 0 && process.platform === 'linux') unixSockets = true
  }
  return { domains: [...domains], unixSockets, weakerNested }
}

export function prepareSandbox(nodes: Iterable<TaskNode>): SandboxArmer | null {
  const union = sandboxRunUnion(nodes)
  if (union === null) return null
  const { domains, unixSockets, weakerNested } = union
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
            ...(unixSockets ? { allowAllUnixSockets: true } : {}),
          })
        } catch (err) {
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
): Promise<SandboxRequest> {
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
  // Pre-create what the task said it will write.
  const placeholders = await prepareOutputsForBind(node.projectDir, sandbox.allow?.write ?? [])
  const request: NonNullable<ExecuteRequest['sandbox']> = {
    // Only what the task declared, plus node_modules. Write paths are
    // readable too: a task that writes `dist/x` expects to read it back
    // (`tsc --incremental` re-reads .tsbuildinfo).
    baseAllowRead: depDirs,
    baseAllowWrite: [],
    // Enforcement anchors at the WORKSPACE ROOT: a task may not leave
    // its project, so every sibling and every root file is denied.
    // Reporting is a different question — see `reportWithin` below.
    baseDenyRead: [workspaceRoot],
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
    config: resolveSandboxConfig(sandbox, node.projectDir),
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
  const scan = async (dir: string, scope: string): Promise<Array<[string, string, string]>> => {
    const found: Array<[target: string, link: string, name: string]> = []
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        const target = await realpath(full).catch(() => undefined)
        if (target !== undefined && !dirs.some((d) => within(target, d)) && !within(self, target)) {
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
    if (!within(target, root) || keyedDirs.has(target)) granted.push(target)
    else
      withheld.push({
        dir: target,
        name,
        target: posixRel(root, target),
        link: posixRel(workspaceRoot, link),
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
    violations.some((v) => v.path !== undefined && within(v.path, w.dir)),
  )
}

/** `p` relative to `from`, with `/` separators. */
function posixRel(from: string, p: string): string {
  return path.relative(from, p).split(path.sep).join('/')
}

/**
 * `p` is `dir` or below it — by path, so a sibling sharing `dir`'s name
 * prefix is not. `/` already ends in the separator, and a link to it
 * holds every project.
 */
function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
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
    // directory is still created when the grant is a glob, because then
    // the static prefix is unambiguously a directory and bwrap cannot
    // bind one that does not exist: `~/.bun/install/cache/**` on a runner
    // that has never populated it silently granted nothing, and the task
    // failed with the tool's own confusing message (`bun build --compile`
    // reported a network error for an unwritable cache; 2026-09-05).
    if (path.isAbsolute(g) || g.startsWith('~')) {
      if (!hasWildcard) continue
      const abs = expandHome(grantPrefix(g))
      await mkdir(abs, { recursive: true }).catch(() => undefined)
      continue
    }
    if (hasWildcard || g.endsWith('/')) {
      const abs = path.join(projectDir, hasWildcard ? grantPrefix(g) : g)
      await mkdir(abs, { recursive: true })
    } else {
      const abs = path.join(projectDir, g)
      // Whatever is already there is what the task meant — a grant on the
      // project dir itself is a directory, and touching it as a file is
      // an EISDIR, not a missing bind.
      if (await stat(abs).catch(() => undefined)) continue
      await mkdir(path.dirname(abs), { recursive: true })
      await Bun.write(abs, '')
      placeholders.push({ path: abs, mtimeMs: (await stat(abs)).mtimeMs })
    }
  }
  return placeholders
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
    const st = await stat(p.path).catch(() => undefined)
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
 * file, and the task's own `mkdir` says only "File exists". Added when
 * the task already failed and the sandbox reported nothing else, so it
 * never reddens a pass and never buries a real denial.
 */
export function untouchedPlaceholderLine(projectDir: string, placeholder: string): string {
  const rel = path.relative(projectDir, placeholder).split(path.sep).join('/')
  return (
    `vx: the sandbox write grant \`${rel}\` named nothing on disk, so vx bound it as an empty ` +
    `file, which the task never wrote (removed again). If the task creates a directory there ` +
    `("File exists" from its own mkdir), spell the grant \`${rel}/\` — a literal without the ` +
    `slash is a file.`
  )
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
    if (within(abs, node.projectDir)) reach = 'project'
    else if (within(abs, workspaceRoot) || within(workspaceRoot, abs)) return 'workspace'
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
      if (within(path.join(workspaceRoot, f), abs)) return true
    }
  }
  return false
}
