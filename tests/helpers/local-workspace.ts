import path from 'node:path'

const here = import.meta.dir
/** Absolute paths — fixtures live in a tmp dir where `@vzn/vx` does not resolve. */
export const CORE_INDEX = path.resolve(here, '../../src/index.ts')
export const LOCAL_EXECUTOR_PLUGIN_PATH = path.resolve(
  here,
  '../../src/plugins/local-executor/index.ts',
)
export const LOCAL_CACHE_PLUGIN_PATH = path.resolve(here, '../../src/plugins/local-cache/index.ts')

/**
 * Source for a `vx.workspace.mjs`: the test's own plugins (JS expressions)
 * FIRST, then the local ones. A plugin file imported by absolute path still
 * resolves its own `'@vzn/vx'` relative to ITS location inside the repo, and
 * Bun keys modules by realpath, so it is the same `src/index.ts` instance the
 * test imports.
 */
export function localWorkspaceSource(extra: readonly string[] = [], prelude = ''): string {
  return `${prelude}
import { localExecutorPlugin } from ${JSON.stringify(LOCAL_EXECUTOR_PLUGIN_PATH)}
import { localCachePlugin } from ${JSON.stringify(LOCAL_CACHE_PLUGIN_PATH)}
export default { plugins: [${[...extra, 'localExecutorPlugin()', 'localCachePlugin()'].join(', ')}] }
`
}

export async function writeLocalWorkspace(root: string): Promise<void> {
  await Bun.write(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource())
}
