// `wireit` and `nps` run the package's own config: lit's member scripts
// (`build: wireit`) each read as running another member's work (D-101).
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

it("does not read a package's own runner as a sibling run", () => {
  const plan = migrateScripts([
    {
      name: 'lib',
      dir: '/w/packages/lib',
      packageJson: { name: 'lib', scripts: { build: 'tsc' } } as never,
      configPath: null,
    },
    {
      name: 'app',
      dir: '/w/packages/app',
      packageJson: {
        name: 'app',
        scripts: {
          build: 'wireit',
          'build:env': 'NODE_ENV=production wireit',
          lint: 'nps lint',
          // CONTROL: a runner that does run the members.
          all: 'lerna run build',
        },
      } as never,
      configPath: null,
    },
  ])
  const app = plan.projects.find((p) => p.name === 'app')!
  expect(
    Object.fromEntries(
      app.tasks.map((t) => [t.name, t.todos.some((s) => s.includes("runs another member's work"))]),
    ),
  ).toEqual({ build: false, 'build:env': false, lint: false, all: true })
})
