import type { TaskConfig } from '@vzn/vx/config'

// turbo.json's inputs for `build` and `prebuild`.
const FILES = [
  '**/*',
  '!test/**/*',
  '!e2e/**/*',
  '!performance/**/*',
  '!.astro/**/*',
  '!.cache/**/*',
  '!mod.js',
  '!mod.js.map',
]

// Outside the package: the tsconfig bases every package extends, and
// `astro-scripts`, the workspace package most builds run, which has no
// build of its own to depend on.
const SHARED = ['configs/**', 'scripts/**', 'tsconfig.json']

const PASS_THROUGH = ['SKIP_OG', 'PUBLIC_TWO_LANG']

/** turbo.json's `build`: after the dependencies' builds and the package's own prebuild. */
export function build(command: string, dependsOn: string[] = ['^build']): TaskConfig {
  return {
    dependsOn,
    exec: { command, env: { passThrough: PASS_THROUGH } },
    // The prebuilt sources reach the key through `prebuild`'s own.
    inputs: { files: [...FILES, '!src/**/*.prebuilt*'], workspaceFiles: SHARED, env: PASS_THROUGH },
    outputs: { files: ['dist/**/*', 'mod.js', 'mod.js.map'] },
    cache: true,
  }
}

/** turbo.json's `prebuild`: the prebuilt sources `build` compiles. */
export function prebuild(command: string): TaskConfig {
  return {
    exec: { command },
    // `build` writes dist/ after this task: its key reads none of it.
    inputs: { files: [...FILES, '!dist/**/*'], workspaceFiles: SHARED },
    outputs: { files: ['src/**/*.prebuilt*'] },
    cache: true,
  }
}
