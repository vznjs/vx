// npm's own aliases run a script as its long names do: `npm run-script x`
// (and `rum`, `urn`) is `npm run x`, `npm t` / `npm tst` is `npm test`,
// and `npm stop` runs the `stop` script; pnpm's `t` / `tst` is its `test`.
// Read verbatim, `ci: npm run-script build` built again beside the
// package's own `build` task, with no TODO saying so.

import { describe, expect, it } from 'bun:test'
import { delegatedScript, migrateScripts } from '../src/migrate-scripts.js'

describe('a package manager alias of run or test', () => {
  it.each([
    ['npm run-script x', 'x'],
    ['npm rum x', 'x'],
    ['npm urn x', 'x'],
    ['npm t', 'test'],
    ['npm tst', 'test'],
    ['npm stop', 'stop'],
    ['pnpm t', 'test'],
    ['pnpm tst', 'test'],
    ['pnpm run-script x', 'x'],
    ['npm run-script x -- --flag', null],
  ])('%s → %p', (command, expected) => {
    expect(delegatedScript(command)).toBe(expected)
  })

  it('a script over another through run-script is a group over it', () => {
    const plan = migrateScripts([
      {
        name: 'a',
        dir: '/nowhere/a',
        configPath: null,
        packageJson: {
          name: 'a',
          scripts: {
            compile: 'tsc',
            build: 'npm run-script compile',
            check: 'npm t',
            test: 'vitest',
          },
        } as never,
      },
    ])
    const tasks = Object.fromEntries(plan.projects[0]!.tasks.map((t) => [t.name, t.task]))
    expect([tasks['build'], tasks['check']]).toEqual([
      { dependsOn: ['compile'] },
      { dependsOn: ['test', 'build'] },
    ])
  })
})
