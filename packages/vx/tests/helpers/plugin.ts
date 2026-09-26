// Plugins for tests: a plugin's name is its package name and nothing else
// (`definePlugin` reads the nearest package.json), so a test that wants a
// plugin called `org/x` gets a package called `org/x` — one directory with
// a manifest under a per-process temp root — and defines the plugin from
// there. `pluginSource` is the same for a plugin written into a fixture's
// `vx.workspace.mjs` as source text.
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
 * Source text for the same plugin inside a fixture `vx.workspace.mjs`:
 * `definePlugin({ dir }, <hooks>)`. Pair it with `PLUGIN_IMPORT` in the
 * file's prelude.
 */
export function pluginSource(name: string, hooks: string): string {
  return `definePlugin(${JSON.stringify(pluginOrigin(name))}, ${hooks})`
}

export { PLUGIN_IMPORT }
