import path from 'node:path'

/** Absolute path — fixtures live in a tmp dir where `@vzn/vx` does not resolve. */
export const CORE_INDEX = path.resolve(import.meta.dir, '../../src/index.ts')

/**
 * The import every fixture workspace file carries: a plugin is made by
 * `definePlugin` and nothing else (`tests/helpers/plugin.ts` builds the
 * `pluginSource` entries that call it).
 */
export const PLUGIN_IMPORT = `import { definePlugin } from ${JSON.stringify(CORE_INDEX)}\n`
