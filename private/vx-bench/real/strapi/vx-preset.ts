import type { TaskConfig } from '@vzn/vx/config'

// nx.json's `default` (the project) and `production`, which adds the root
// rollup config every `rollup -c` imports.
const inputs = { files: ['**/*'], workspaceFiles: ['rollup.utils.mjs'] }

// `run-p a b`: each command at once, the task failing when any fails.
const together = (commands: string[]): string =>
  commands.length === 1
    ? commands[0]!
    : `${commands
        .slice(0, -1)
        .map((c, i) => `${c} & p${i}=$!; `)
        .join('')}${commands.at(-1)} && ${commands
        .slice(0, -1)
        .map((_, i) => `wait $p${i}`)
        .join(' && ')}`

/**
 * nx.json's `build:code`: no `dependsOn`, as the repo's own `build` script
 * runs it. It and `build:types` share `dist/`, so each declares its half.
 */
export function buildCode(...commands: string[]): TaskConfig {
  return {
    exec: { command: together(commands) },
    inputs,
    outputs: { files: ['dist/**', '!dist/**/*.d.ts', '!dist/**/*.d.ts.map'] },
    cache: true,
  }
}

/** nx.json's `build:types`: after the dependencies' declarations. */
export function buildTypes(...commands: string[]): TaskConfig {
  return {
    dependsOn: ['^build:types'],
    exec: { command: together(commands) },
    inputs,
    outputs: { files: ['dist/**/*.d.ts', 'dist/**/*.d.ts.map'] },
    cache: true,
  }
}
