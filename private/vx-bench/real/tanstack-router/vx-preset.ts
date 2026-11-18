import type { TaskConfig } from '@vzn/vx/config'

// nx.json's `sharedGlobals`, part of `buildProduction`.
const SHARED_GLOBALS = [
  '.npmrc',
  '.nx/workflows/sandboxing-config.yaml',
  '.nvmrc',
  'package.json',
  'tsconfig.json',
]

const inputs = (more: string[] = []): { files: string[]; workspaceFiles: string[] } => ({
  files: ['**/*'],
  workspaceFiles: [...SHARED_GLOBALS, ...more],
})

/** nx.json's `build`: after the dependencies' builds, the five output directories. */
export function build(command = 'vite build'): TaskConfig {
  return {
    dependsOn: ['^build'],
    exec: { command },
    inputs: inputs(),
    outputs: { files: ['.netlify/**', '.wrangler/**', '.output/**', 'build/**', 'dist/**'] },
    cache: true,
  }
}

/** nx.json's `test:build`: publint and attw over the package's own build, no outputs. */
export function testBuild(
  command = 'publint --strict && attw --ignore-rules no-resolution --pack .',
): TaskConfig {
  return {
    dependsOn: ['build'],
    exec: { command },
    inputs: inputs(),
    outputs: { files: [] },
    cache: true,
  }
}

/** `@benchmarks/bundle-size#build`: its own outputs, and the two scripts it runs. */
export function measure(command: string): TaskConfig {
  return {
    dependsOn: ['^build'],
    exec: { command },
    inputs: {
      ...inputs([
        'scripts/benchmarks/bundle-size/measure.mjs',
        'scripts/benchmarks/bundle-size/report.mjs',
      ]),
      workspaceRuntime: ['node --version'],
    },
    outputs: {
      files: ['dist/**', 'results/measurements.json', 'results/benchmark-action.json'],
    },
    cache: true,
  }
}
