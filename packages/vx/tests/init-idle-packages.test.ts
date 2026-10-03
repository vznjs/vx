// A member with no script to run gets no vx.config.ts from `vx init`, and
// it vanished from the report: a pnpm or bun workspace's types-only and
// config packages (no scripts, or only `postinstall`) read as forgotten.
// The report names them and says they are still projects.
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

const meta = (name: string, dir: string, scripts?: Record<string, string>) => ({
  name,
  dir,
  packageJson: (scripts === undefined ? { name } : { name, scripts }) as never,
  configPath: null,
})

const idle = (...members: [string, Record<string, string> | undefined][]): string[] =>
  migrateScripts([
    meta('root', '/w'),
    meta('app', '/w/packages/app', { build: 'tsc -b' }),
    ...members.map(([n, s]) => meta(n, `/w/packages/${n}`, s)),
  ]).notes.filter((n) => n.includes('no vx.config.ts'))

it('names the members with no script to run', () => {
  expect(idle(['types', undefined], ['cfg', { postinstall: 'node setup.js' }])).toEqual([
    "2 packages got no vx.config.ts, having no script to run (none, or only the package manager's lifecycle hooks): types, cfg; each is still a project, and a task declared in its own vx.config.ts runs",
  ])
  expect(idle(['types', {}])).toEqual([
    "1 package got no vx.config.ts, having no script to run (none, or only the package manager's lifecycle hooks): types; each is still a project, and a task declared in its own vx.config.ts runs",
  ])
})

it('names none that map, build in a lifecycle hook, or when nothing maps (controls)', () => {
  expect(idle(['lib', { test: 'vitest' }])).toEqual([])
  // Its own note names it: "builds only in a lifecycle script".
  expect(idle(['core', { prepack: 'tsc -b' }])).toEqual([])
  // With no task anywhere, init prints its how-to instead of a report.
  expect(
    migrateScripts([meta('root', '/w'), meta('types', '/w/packages/types')]).notes.filter((n) =>
      n.includes('no vx.config.ts'),
    ),
  ).toEqual([])
})
