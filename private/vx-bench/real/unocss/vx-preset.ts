import type { TaskConfig } from '@vzn/vx/config'

/**
 * turbo.json's `build`: the package's own script after its dependencies'
 * builds, `dist/**` out. The tsdown configs import the root `alias.ts`,
 * which points into `virtual-shared/` (turbo.json's `globalDependencies`),
 * and every tsconfig extends the root's.
 */
export function build(command = 'tsdown --config-loader unrun'): TaskConfig {
  return {
    dependsOn: ['^build'],
    exec: { command },
    inputs: {
      files: ['**/*'],
      workspaceFiles: ['alias.ts', 'tsconfig.json', 'virtual-shared/**'],
    },
    outputs: { files: ['dist/**'] },
    cache: true,
  }
}
