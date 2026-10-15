// A member that runs a workspace package's bin it gets only through the
// root's dependencies has no `^build` edge to it: vite's playgrounds run
// `vite` from the root's `vite: workspace:*`, and 64 of 70 built before
// vite did (Growth's trial 4, 2026-10-13). init adds that package's build.
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/migrate-scripts.js'

const meta = (name: string, dir: string, json: Record<string, unknown>) => ({
  name,
  dir,
  packageJson: { name, ...json } as never,
  configPath: null,
})

it("waits on the build of a workspace bin the root's dependencies link", () => {
  const plan = migrateScripts(
    [
      meta('vite', '/w/packages/vite', {
        bin: { vite: 'bin/vite.js' },
        scripts: { build: 'rolldown -c' },
      }),
      meta('@scope/tool', '/w/packages/tool', { bin: './cli.js', scripts: { build: 'tsc' } }),
      meta('play', '/w/playground/play', {
        scripts: { build: 'vite build', dev: 'vite', gen: 'tool gen && echo ok' },
      }),
      // CONTROLS: one that depends on vite itself has `^build`; a bin the
      // root does not depend on; a script naming no bin.
      meta('own', '/w/playground/own', {
        devDependencies: { vite: 'workspace:*' },
        scripts: { build: 'vite build' },
      }),
      meta('quiet', '/w/playground/quiet', { scripts: { build: 'echo vite', lint: 'eslint .' } }),
    ],
    { name: 'root', devDependencies: { vite: 'workspace:*', '@scope/tool': 'workspace:*' } },
    '/w',
  )
  const deps = Object.fromEntries(
    plan.projects.flatMap((p) =>
      p.tasks.map((t) => [
        `${p.name}#${t.name}`,
        (t.task?.['dependsOn'] as string[] | undefined) ?? [],
      ]),
    ),
  )
  expect({
    build: deps['play#build'],
    gen: deps['play#gen'],
    own: deps['own#build'],
    lint: deps['quiet#lint'],
  }).toEqual({
    build: ['^build', 'vite#build'],
    gen: ['@scope/tool#build'],
    own: ['^build'],
    lint: [],
  })
})
