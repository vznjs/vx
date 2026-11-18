import type { TaskConfig } from '@vzn/vx/config'

// turbo.json's globalEnv: keyed and passed for every task.
const GLOBAL_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_TABLE_NAME',
  'SPAM_ASSASSIN_HOST',
  'SPAM_ASSASSIN_PORT',
  'PLAYWRIGHT_BROWSERS_PATH',
]

/**
 * turbo.json's `build`: the package's script, after its dependencies'
 * builds. Each tsconfig extends the `tsconfig` package, which has no build
 * to depend on, so its files are named.
 */
export function build(command: string, outputs: string[] = ['dist/**']): TaskConfig {
  return {
    dependsOn: ['^build'],
    exec: { command, env: { passThrough: GLOBAL_ENV } },
    inputs: { files: ['**/*'], workspaceFiles: ['packages/tsconfig/*.json'], env: GLOBAL_ENV },
    outputs: { files: outputs },
    cache: true,
  }
}
