import type { TaskConfig } from '@vzn/vx/config'

// turbo.json's outputs are `*/**` and `.medusa/**` less `src` and
// `node_modules`: what a build writes there is `dist` and `.medusa`.
const OUTPUTS = ['dist/**', '.medusa/**']

// Every tsconfig extends the root's base.
const SHARED = ['_tsconfig.base.json']

/** turbo.json's `build`: the package's script after its dependencies' builds. */
export const build: TaskConfig = {
  dependsOn: ['^build'],
  exec: { command: 'yarn run build' },
  inputs: { files: ['**/*'], workspaceFiles: SHARED },
  outputs: { files: OUTPUTS },
  cache: true,
}

/** turbo.json's `build:plugin`: after the dependencies' builds and `@medusajs/medusa`'s, whose CLI it runs. */
export const buildPlugin: TaskConfig = {
  dependsOn: ['^build', '@medusajs/medusa#build'],
  exec: { command: 'yarn run build:plugin' },
  inputs: { files: ['**/*'], workspaceFiles: SHARED },
  outputs: { files: ['.medusa/**'] },
  cache: true,
}
