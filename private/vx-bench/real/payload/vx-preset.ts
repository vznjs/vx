import type { TaskConfig } from '@vzn/vx/config'

/**
 * turbo.json's `build`: the package's script after its dependencies'
 * builds, `dist/**` out. The scripts chain their steps through pnpm
 * (`pnpm build:types && pnpm build:swc`), so the task runs the script as
 * Turbo does. Every tsconfig extends the root's.
 */
export const build: TaskConfig = {
  dependsOn: ['^build'],
  // The bench raises Node's heap for `payload`'s type bundle (nightly.ts).
  exec: { command: 'pnpm run build', env: { passThrough: ['NODE_OPTIONS'] } },
  inputs: { files: ['**/*'], workspaceFiles: ['tsconfig.base.json'] },
  outputs: { files: ['dist/**'] },
  cache: true,
}
