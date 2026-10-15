import path from 'node:path'
import { PLUGIN_IMPORT } from './core-index.js'
import { packagesSource } from './plugin.js'

export { CORE_INDEX, PLUGIN_IMPORT } from './core-index.js'

/**
 * Source for a `.vx/workspace.mjs` declaring the test's own plugins, after
 * `packages()` unless one of them is it: core reads no package.json, and
 * fixtures are written as packages named by their manifests.
 *
 * Running here and caching here are core's fallbacks, so a fixture that
 * wants neither needs only a bare workspace file, which marks the root. A plugin file imported by
 * absolute path still resolves its own `'@vzn/vx'` relative to ITS location
 * inside the repo, and Bun keys modules by realpath, so it is the same
 * `src/index.ts` instance the test imports.
 */
export function localWorkspaceSource(
  extra: readonly string[] = [],
  prelude = '',
  rules?: string,
): string {
  const plugins = extra.some((p) => p.includes('/vx-test-packages"'))
    ? extra
    : [packagesSource(), ...extra]
  return `${PLUGIN_IMPORT}${prelude}
export default { plugins: [${plugins.join(', ')}]${rules === undefined ? '' : `, run: { rules: ${rules} }`} }
`
}

/**
 * The `rules` of a fixture whose key reads another task's outputs: the
 * default `rules.upfrontKeys` refuses that config (X-54), and the rows
 * that pin how vx keeps such a key correct need it loaded.
 */
export const WAIT_FOR_PRODUCERS = '{ upfrontKeys: false }'

/** Rewrites `root`'s `.vx/workspace.mjs` with `WAIT_FOR_PRODUCERS` and only the `extra` plugins. */
export async function waitForProducers(root: string, extra: readonly string[] = []): Promise<void> {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(extra, '', WAIT_FOR_PRODUCERS),
  )
}

export async function writeLocalWorkspace(root: string): Promise<void> {
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
}

/** `localWorkspaceSource()` with `fields` (an object-literal body) beside its plugins. */
export function workspaceWith(fields: string): string {
  return `${PLUGIN_IMPORT}export default { plugins: [${packagesSource()}], ${fields} }\n`
}
