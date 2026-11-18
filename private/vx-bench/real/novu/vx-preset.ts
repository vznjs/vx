import type { TaskConfig } from '@vzn/vx/config'

/**
 * nx.json's `build`: after the dependencies' builds, keyed on the project,
 * the root tsconfig and the Node version (`sharedGlobals`); outputs `dist`
 * and `build` unless the project names its own.
 */
export function build(
  command = 'pnpm run build',
  outputs: string[] = ['dist/**', 'build/**'],
  dependsOn: string[] = ['^build'],
): TaskConfig {
  return {
    dependsOn,
    exec: { command },
    inputs: {
      files: ['**/*'],
      workspaceFiles: ['tsconfig.json'],
      workspaceRuntime: ['node --version'],
    },
    outputs: { files: outputs },
    cache: true,
  }
}
