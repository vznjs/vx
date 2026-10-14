// Plugins for tests: a plugin's name is its package name and nothing else
// (`definePlugin` reads the nearest package.json), so a test that wants a
// plugin called `org/x` gets a package called `org/x` — one directory with
// a manifest under a per-process temp root — and defines the plugin from
// there. `pluginSource` is the same for a plugin written into a fixture's
// `.vx/workspace.mjs` as source text.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { definePlugin, type PluginHooks, type VxPlugin } from '../../src/index.js'
import { PLUGIN_IMPORT } from './local-workspace.js'

let root: string | undefined
const dirs = new Map<string, string>()

/**
 * The root is one per PROCESS — this module is evaluated once and shared by
 * every file `bun test` runs in it — so no file's `afterAll` may own it, and
 * `bun test` fires neither `exit` nor `beforeExit` (measured 2026-09-16; 164
 * roots sat in /tmp after one day's gates). So the root carries the pid,
 * and the next process to need one sweeps the roots of dead pids: the same
 * reclaim the run lock uses. Litter is bounded to the processes still
 * running, and the next `bun test` removes the last one's.
 *
 * A pid says nothing inside the sandbox: every sandboxed shard's test
 * process is pid 2 in a namespace of its own, so each saw pid 2 alive and
 * swept nothing (478 roots in one box's `/tmp/claude`, item 879). A root
 * no process has added to for an hour is swept whatever its pid says: a
 * shard lives minutes and the gate is cut at 25.
 */
function processRoot(): string {
  if (root !== undefined) return root
  const tmp = tmpdir()
  for (const name of readdirSync(tmp)) {
    const m = /^vx-plugin-pkgs-(\d+)-/.exec(name)
    if (m === null || (alive(Number(m[1])) && !idle(path.join(tmp, name)))) continue
    // Another user's dead root is not ours to remove (EPERM): the gate's
    // shards run as an unprivileged user beside roots a root-run suite
    // left, and one such root took every plugin test down (2026-09-16).
    try {
      rmSync(path.join(tmp, name), { recursive: true, force: true })
    } catch {
      // left for its owner
    }
  }
  root = mkdtempSync(path.join(tmp, `vx-plugin-pkgs-${process.pid}-`))
  return root
}

const IDLE_MS = 60 * 60 * 1000

function idle(dir: string): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs > IDLE_MS
  } catch {
    return false
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: another user's live process; ESRCH: gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `{ dir }` of a package named `name`, created on first use. */
export function pluginOrigin(name: string): { dir: string } {
  const known = dirs.get(name)
  if (known !== undefined) return { dir: known }
  const dir = path.join(processRoot(), name.replace(/[@/]/g, '_'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }))
  dirs.set(name, dir)
  return { dir }
}

/** A plugin named `name` for in-process use. */
export function testPlugin(name: string, hooks: PluginHooks): VxPlugin {
  return definePlugin(pluginOrigin(name), hooks)
}

/**
 * Source text for the same plugin inside a fixture `.vx/workspace.mjs`:
 * `definePlugin({ dir }, <hooks>)`. Pair it with `PLUGIN_IMPORT` in the
 * file's prelude.
 */
export function pluginSource(name: string, hooks: string): string {
  return `definePlugin(${JSON.stringify(pluginOrigin(name))}, ${hooks})`
}

export { PLUGIN_IMPORT }

/** Project name → the project names it builds after (or, for `reach`, is reached through). */
export type EdgeMap = Readonly<Record<string, readonly string[]>>

/**
 * The `discover` hooks of `edges()`: every project gets `deps` (none
 * unless named), so the workspace is an edge source, and a named project
 * its `reach`. Names resolve through the projects the stage sees; one that
 * is no project is skipped, so one map can serve fixtures that add
 * projects as they go.
 */
function edgesHooks(deps: EdgeMap, reach: EdgeMap): string {
  return `{
  discover(ctx) {
    const deps = ${JSON.stringify(deps)}
    const reach = ${JSON.stringify(reach)}
    const dir = new Map(ctx.projects.map((p) => [p.name, p.dir]))
    const dirs = (names) => names.filter((n) => dir.has(n)).map((n) => dir.get(n))
    return ctx.projects.map((p) => ({
      dir: p.dir,
      deps: dirs(deps[p.name] ?? []),
      ...(reach[p.name] === undefined ? {} : { reach: dirs(reach[p.name]) }),
    }))
  },
}`
}

/**
 * A test plugin supplying project edges as a lockfile plugin does, for
 * in-process use. Core reads no manifest edge, so a fixture whose `^task`
 * needs an upstream declares it here.
 */
export function edges(deps: EdgeMap = {}, reach: EdgeMap = {}): VxPlugin {
  return testPlugin('vx-test-edges', {
    discover(ctx) {
      const dir = new Map(ctx.projects.map((p) => [p.name, p.dir]))
      const dirs = (names: readonly string[]): string[] =>
        names.filter((n) => dir.has(n)).map((n) => dir.get(n)!)
      return ctx.projects.map((p) => {
        const near = reach[p.name]
        return {
          dir: p.dir,
          deps: dirs(deps[p.name] ?? []),
          ...(near === undefined ? {} : { reach: dirs(near) }),
        }
      })
    },
  })
}

/** `edges()` as source text for a fixture `.vx/workspace.mjs`; pair it with `PLUGIN_IMPORT`. */
export function edgesSource(deps: EdgeMap = {}, reach: EdgeMap = {}): string {
  return pluginSource('vx-test-edges', edgesHooks(deps, reach))
}

/** Rewrites `root`'s `.vx/workspace.mjs` to declare `edges()` and nothing else. */
export async function writeEdges(
  root: string,
  deps: EdgeMap = {},
  reach: EdgeMap = {},
): Promise<void> {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${edgesSource(deps, reach)}] }\n`,
  )
}

/**
 * Source text for a test plugin that claims `files` at the root and folds
 * each one's bytes whole into every key, as a lockfile plugin's `workspace`
 * scope does: core keys no root file, so a fixture whose keys must move
 * with a lockfile declares this. Pair it with `PLUGIN_IMPORT`.
 */
function lockClaimSource(files: readonly string[] = ['pnpm-lock.yaml']): string {
  return pluginSource(
    'vx-test-lock',
    `{
  fingerprint: { files: ${JSON.stringify(files)}, affected: () => undefined },
  async key(task, ctx) {
    const out = {}
    for (const f of ${JSON.stringify(files)}) {
      const file = Bun.file(ctx.workspaceRoot + '/' + f)
      if (await file.exists()) out[f] = Bun.hash.xxHash3(await file.bytes()).toString(16)
    }
    return out
  },
}`,
  )
}

/** Rewrites `root`'s `.vx/workspace.mjs` to declare `lockClaimSource(files)` and nothing else. */
export async function writeLockClaim(
  root: string,
  files: readonly string[] = ['pnpm-lock.yaml'],
): Promise<void> {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${lockClaimSource(files)}] }\n`,
  )
}
