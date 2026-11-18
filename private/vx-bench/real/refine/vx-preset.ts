import type { TaskConfig } from '@vzn/vx/config'

/**
 * nx.json's `build`: the package's script after its dependencies' builds;
 * outputs `.next`, `build` and `dist`. Every tsup config imports plugins
 * from packages/shared/, which is no project, and every tsconfig extends
 * the root's.
 */
export function build(command: string): TaskConfig {
  return {
    dependsOn: ['^build'],
    exec: { command },
    inputs: {
      files: ['**/*'],
      workspaceFiles: ['packages/shared/**', 'tsconfig.build.json', 'tsconfig.json'],
    },
    outputs: { files: ['.next/**', 'build/**', 'dist/**'] },
    cache: true,
  }
}

export const TSUP = 'tsup && node ../shared/generate-declarations.js'
