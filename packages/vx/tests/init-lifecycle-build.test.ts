// A package whose build lives only in a lifecycle hook (react-navigation's
// `prepack: bob build`) is named in the report: vx never runs the hook,
// and the repo mapped with no build at all.
import { expect, it } from 'bun:test'
import { migrateScripts } from '../src/workspace/migrate-scripts.js'

const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
  name,
  dir,
  packageJson: { name, scripts } as never,
  configPath: null,
})

const note = (...members: [string, Record<string, string>][]): string[] =>
  migrateScripts([
    meta('root', '/w', { build: 'lerna run prepack', prepack: 'tsc -b' }),
    ...members.map(([n, s]) => meta(n, `/w/packages/${n}`, { clean: 'del lib', ...s })),
  ]).notes.filter((n) => n.includes('lifecycle script'))

it('names the packages that build only in a lifecycle hook', () => {
  expect(
    note(['core', { prepack: 'bob build' }], ['stack', { prepublishOnly: 'tsc -p .' }]),
  ).toEqual([
    '2 packages build only in a lifecycle script (`prepack: bob build` in core and 1 more), which the package manager runs on pack or install and vx never runs: add a `build` script running it and run `vx init` again',
  ])
  expect(note(['core', { prepare: 'tsup src' }])).toEqual([
    'a package builds only in a lifecycle script (`prepare: tsup src` in core), which the package manager runs on pack or install and vx never runs: add a `build` script running it and run `vx init` again',
  ])
  // CONTROLS: a package with a build, a hook that builds nothing, and the
  // root's own hook.
  expect(note(['core', { build: 'bob build', prepack: 'bob build' }])).toEqual([])
  expect(note(['core', { prepare: 'husky' }])).toEqual([])
  expect(note()).toEqual([])
})
