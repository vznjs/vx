// Plugins for tests: a plugin's name is its package name and nothing else
// (`definePlugin` reads the nearest package.json), so a test that wants a
// plugin called `org/x` gets a package called `org/x` — one directory with
// a manifest under a per-process temp root — and defines the plugin from
// there. `pluginSource` is the same for a plugin written into a fixture's
// `vx.workspace.mjs` as source text.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { definePlugin, type PluginHooks, type VxPlugin } from '../../src/index.js'
import { PLUGIN_IMPORT } from './local-workspace.js'

let root: string | undefined
const dirs = new Map<string, string>()

/** `{ dir }` of a package named `name`, created on first use. */
export function pluginOrigin(name: string): { dir: string } {
  const known = dirs.get(name)
  if (known !== undefined) return { dir: known }
  root ??= mkdtempSync(path.join(tmpdir(), 'vx-plugin-pkgs-'))
  const dir = path.join(root, name.replace(/[@/]/g, '_'))
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
