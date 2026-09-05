import path from 'node:path'

const here = import.meta.dir

/** Absolute path — fixtures live in a tmp dir where `@vzn/vx` does not resolve. */
export const CORE_INDEX = path.resolve(here, '../../src/index.ts')

/**
 * Source for a `vx.workspace.mjs` declaring the test's own plugins.
 *
 * Running here and caching here are core's fallbacks, so a fixture that
 * wants neither needs no workspace file at all — `writeLocalWorkspace` is
 * kept for the tests that assert on one existing. A plugin file imported by
 * absolute path still resolves its own `'@vzn/vx'` relative to ITS location
 * inside the repo, and Bun keys modules by realpath, so it is the same
 * `src/index.ts` instance the test imports.
 */
export function localWorkspaceSource(extra: readonly string[] = [], prelude = ''): string {
  return `${prelude}
export default { plugins: [${extra.join(', ')}] }
`
}

export async function writeLocalWorkspace(root: string): Promise<void> {
  await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource())
}
