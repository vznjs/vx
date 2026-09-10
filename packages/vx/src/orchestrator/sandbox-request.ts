// The sandbox half of an `ExecuteRequest`: what a task may read and write,
// where denials are reported, and the filesystem groundwork a bind needs
// (bwrap cannot bind a path that does not exist). Shared by the cached path
// (through the executor) and the persistent path (spawned in execute-task).

import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ExecConfig } from '../config.js'
import {
  initSandbox,
  probeSandbox,
  resolveSandboxConfig,
  type ExecuteRequest,
} from '../exec/index.js'
import type { TaskNode } from '../graph/index.js'
import { staticPrefix, UserError } from '../util/index.js'

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
export function prepareSandbox(nodes: Iterable<TaskNode>): SandboxArmer | null {
  const sandboxed = [...nodes].filter((n) => n.config.exec?.sandbox !== undefined)
  if (sandboxed.length === 0) return null
  const weakerNested = sandboxed.every((n) => n.config.exec?.sandbox?.weakerWhenNested === true)
  const domains = new Set<string>()
  let unixSockets = false
  for (const n of sandboxed) {
    const allow = n.config.exec?.sandbox?.allow
    const net = allow?.network
    if (Array.isArray(net)) for (const d of net) domains.add(d)
    const sockets = allow?.unixSockets
    if (sockets === true || (Array.isArray(sockets) && sockets.length > 0)) unixSockets = true
    const lb = allow?.localBinding
    if (Array.isArray(lb) && lb.length > 0 && process.platform === 'linux') unixSockets = true
  }
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
            allowedDomains: [...domains],
            ...(unixSockets ? { allowAllUnixSockets: true } : {}),
          })
        } catch (err) {
          // A throw from the runtime itself (its bridge needs socat, which
          // the dependency check does not cover) gets the same one-line
          // verdict as a refused probe, not an internal error with a stack.
          if (err instanceof UserError) throw err
          throw new UserError(
            `sandbox not available: ${err instanceof Error ? err.message : String(err)}`,
          )
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
 * The sandbox derives NOTHING from `cache` (owner, 2026-09-05). Those are
 * two different questions: `cache.inputs` says what INVALIDATES the task,
 * `sandbox.allow` says what it may TOUCH. Deriving one from the other
 * coupled them in both directions — a declaration added for caching
 * silently widened the sandbox, and a path the task needed had to be
 * laundered through the cache key to get it. A sandboxed task declares
 * its own reads and writes.
 *
 * `node_modules` is the one grant core still makes, and it is not
 * cache-derived: it is where the task's own PATH gets its `.bin` entries,
 * and denying it made the sandbox unusable for anything that imports a
 * dependency (`bun build --compile` died with only `error: An unknown
 * error occurred (Unexpected)`; owner call 2026-09-04).
 */
export async function sandboxRequestFor(
  node: TaskNode,
  sandbox: NonNullable<ExecConfig['sandbox']>,
  workspaceRoot: string,
): Promise<NonNullable<ExecuteRequest['sandbox']>> {
  const depDirs = [
    path.join(node.projectDir, 'node_modules'),
    path.join(workspaceRoot, 'node_modules'),
  ]
  // A workspace dependency is a SYMLINK in `node_modules` pointing at a
  // sibling project, so granting `node_modules` grants a link whose
  // target is outside it. That target is a dependency, not a reach-out:
  // no project config should have to name a sibling to import what its
  // own `package.json` depends on (owner, 2026-09-05).
  depDirs.push(...(await linkedDeps(depDirs)))
  // bwrap cannot --bind a path that does not exist: the bind silently
  // becomes a no-op and writes to it appear to succeed but never land.
  // Pre-create what the task said it will write.
  await prepareOutputsForBind(node.projectDir, sandbox.allow?.write ?? [])
  return {
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
    config: resolveSandboxConfig(sandbox, node.projectDir),
  }
}

/**
 * Where the workspace links in `dirs` actually point.
 *
 * One level deep, plus one level inside a `@scope/` directory — the shape
 * a package manager writes. Anything already inside a granted directory
 * is dropped; what is left is a sibling project's real path.
 */
async function linkedDeps(dirs: readonly string[]): Promise<string[]> {
  const out = new Set<string>()
  const scan = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        const target = await realpath(full).catch(() => undefined)
        if (
          target !== undefined &&
          !dirs.some((d) => target === d || target.startsWith(d + path.sep))
        ) {
          out.add(target)
        }
      } else if (depth === 0 && e.isDirectory() && e.name.startsWith('@')) {
        await scan(full, 1)
      }
    }
  }
  await Promise.all(dirs.map((d) => scan(d, 0)))
  return [...out]
}

/**
 * Ensure each declared output path exists on the host as either an
 * empty file (for literal output specs) or a directory (for globbed
 * specs) so bwrap's --bind can find a real fs entry to mount. Without
 * this, writes inside the sandbox to a non-existent allowWrite path
 * silently disappear (bwrap creates a tmpfs that evaporates on exit).
 *
 * `cleanOutputs` ran just before this in the cache-enabled path, so
 * we know any stale content was wiped; what's left is to materialize
 * the empty skeleton.
 */
async function prepareOutputsForBind(
  projectDir: string,
  outputs: readonly string[],
): Promise<void> {
  for (const g of outputs) {
    const hasWildcard = /[*?[\]]/.test(g)
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
      const abs = expandHome(staticPrefix(g))
      await mkdir(abs, { recursive: true }).catch(() => undefined)
      continue
    }
    if (hasWildcard) {
      const abs = path.join(projectDir, staticPrefix(g))
      await mkdir(abs, { recursive: true })
    } else {
      const abs = path.join(projectDir, g)
      // Whatever is already there is what the task meant — a grant on the
      // project dir itself is a directory, and touching it as a file is
      // an EISDIR, not a missing bind.
      if (await stat(abs).catch(() => undefined)) continue
      await mkdir(path.dirname(abs), { recursive: true })
      await Bun.write(abs, '')
    }
  }
}

/** `~/x` against the user's home; anything else unchanged. */
function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p
}
