// A root `wireit` script is judged by the command its config runs: lit's
// root `lint:check` (eslint) was left out as a runner of the members.
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

it("maps a root wireit check, and leaves out one that runs a member's work", () => {
  const plan = migrateScripts([
    {
      name: 'root',
      dir: '/w',
      packageJson: {
        name: 'root',
        scripts: { 'lint:check': 'wireit', aggregate: 'wireit', starter: 'wireit', size: 'wireit' },
        wireit: {
          'lint:check': { command: 'eslint .', files: ['**/*.ts'], output: [] },
          // No command, edges into the members: an aggregate, left out.
          aggregate: { dependencies: ['./packages/a:build'] },
          starter: { command: 'cd packages/a && npm run build' },
          size: { command: 'node size.js', dependencies: ['./packages/a:build'] },
        },
      } as never,
      configPath: null,
    },
    {
      name: 'a',
      dir: '/w/packages/a',
      packageJson: { name: 'a', scripts: { build: 'tsc' } } as never,
      configPath: null,
    },
  ])
  const root = plan.projects.find((p) => p.name === 'root')!
  expect(Object.fromEntries(root.tasks.map((t) => [t.name, t.task]))).toEqual({
    'lint:check': {
      exec: { command: 'eslint .' },
      cache: { inputs: { files: ['**/*.ts'] }, outputs: { files: [] } },
    },
    size: { exec: { command: 'node size.js' }, dependsOn: ['a#build'] },
  })
})
