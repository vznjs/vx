import type { TaskConfig } from '@vzn/vx/config'

// nx.json's `sharedGlobals`, part of every `production` input set.
const SHARED_GLOBALS = [
  '.nvmrc',
  'package.json',
  'scripts/*.js',
  'tsconfig.json',
  'eslint.config.js',
  'pnpm-workspace.yaml',
]

// nx.json's `production` over a dependency that has no build to depend on.
const production = (pkg: string): string[] => [
  `packages/${pkg}/**/*`,
  `!packages/${pkg}/**/*.md`,
  `!packages/${pkg}/tests/**/*`,
  `!packages/${pkg}/eslint.config.js`,
]

/**
 * nx.json's `build`: inputs `production` and `^production`, outputs `build`
 * and `dist`. A dependency's build folds its own inputs into this key;
 * `unbuilt` names the workspace dependencies with no build.
 */
export function build(command: string, unbuilt: string[] = []): TaskConfig {
  return {
    dependsOn: ['^build'],
    exec: { command },
    inputs: {
      files: ['**/*', '!**/*.md', '!tests/**/*', '!eslint.config.js'],
      workspaceFiles: [...SHARED_GLOBALS, ...unbuilt.flatMap(production)],
    },
    outputs: { files: ['build/**', 'dist/**'] },
    cache: true,
  }
}

export const TSDOWN = 'tsdown --tsconfig tsconfig.prod.json'
export const SVELTE = 'svelte-package --input ./src --output ./dist'
// `pnpm build:tsdown && pnpm build:codemods`, as its two commands.
export const WITH_CODEMODS = `${TSDOWN} && rm -rf ./build/codemods && mkdir ./build/codemods && cp -r ../query-codemods/src/* ./build/codemods`
