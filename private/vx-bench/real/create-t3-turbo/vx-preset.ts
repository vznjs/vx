import type { TaskConfig } from '@vzn/vx/config'

// turbo.json's globalEnv keys every task; its globalPassThroughEnv reaches
// every task unkeyed. vx keys and passes per task: each task here takes both.
const GLOBAL_ENV = [
  'POSTGRES_URL',
  'AUTH_DISCORD_ID',
  'AUTH_DISCORD_SECRET',
  'AUTH_REDIRECT_PROXY_URL',
  'AUTH_SECRET',
  'PORT',
]
const PASS_THROUGH = ['NODE_ENV', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL', 'npm_lifecycle_event']

// What a package's tsc, eslint and prettier read outside it: the shared
// configs under tooling/, reached through node_modules.
const TOOLING: Record<string, string[]> = {
  tsc: ['tooling/typescript/*.json'],
  eslint: ['tooling/eslint/**', 'tooling/typescript/*.json'],
  prettier: ['tooling/prettier/**', '.gitignore'],
}

/** One turbo.json task: the package's script as its command, cached. */
function task(
  command: string,
  tool: keyof typeof TOOLING,
  rest: { dependsOn?: string[]; outputs?: string[] } = {},
): TaskConfig {
  return {
    ...(rest.dependsOn === undefined ? {} : { dependsOn: rest.dependsOn }),
    exec: { command, env: { passThrough: [...GLOBAL_ENV, ...PASS_THROUGH] } },
    inputs: { files: ['**/*'], workspaceFiles: TOOLING[tool]!, env: GLOBAL_ENV },
    outputs: { files: rest.outputs ?? [] },
    cache: true,
  }
}

// turbo.json's `topo`: a keyed node per package that `^topo` reaches
// through, so lint and typecheck re-key when any dependency changes,
// built or not. Nothing runs for it.
export const topo: TaskConfig = { dependsOn: ['^topo'], inputs: { files: ['**/*'] } }

// turbo.json gives `build` and `typecheck` the same output,
// `.cache/tsbuildinfo.json`; vx refuses two tasks on one path (a run cleans
// a task's outputs first), so where a package has a build, the build owns it.
export const typecheck = (command: string, built = false): TaskConfig =>
  task(command, 'tsc', {
    dependsOn: ['^topo', '^build'],
    outputs: built ? [] : ['.cache/tsbuildinfo.json'],
  })

export const lint: TaskConfig = task('eslint --flag unstable_native_nodejs_ts_config', 'eslint', {
  dependsOn: ['^topo', '^build'],
  outputs: ['.cache/.eslintcache'],
})

export const format: TaskConfig = task(
  'prettier --check . --ignore-path ../../.gitignore',
  'prettier',
  { outputs: ['.cache/.prettiercache'] },
)

export const build: TaskConfig = task('tsc', 'tsc', {
  dependsOn: ['^build'],
  outputs: ['.cache/tsbuildinfo.json', 'dist/**'],
})
