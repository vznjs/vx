import type { TaskConfig } from '@vzn/vx/config'

// What every tsdown build reads outside its package: the shared tsdown
// config and package list, and the root tsconfig whose `paths` point each
// `@vueuse/*` import at that package's sources.
const SHARED = ['tsdown.config.ts', 'meta/**', 'tsconfig.json']

/**
 * turbo.json's `build` (`dist/**`). `deps` are the workspace packages it
 * imports, read as sources through the tsconfig `paths`, not as builds:
 * their sources are inputs, and no build waits on another. Every build
 * waits on `@vueuse/metadata#update`: the root tsdown config imports the
 * `index.json` it writes, an edge turbo.json leaves implicit.
 */
export function build(deps: string[], command = 'tsdown'): TaskConfig {
  return {
    dependsOn: ['@vueuse/metadata#update'],
    exec: { command },
    inputs: {
      files: ['**/*'],
      workspaceFiles: [...SHARED, ...deps.map((d) => `packages/${d}/**`)],
    },
    outputs: { files: ['dist/**'] },
    cache: true,
  }
}
