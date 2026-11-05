import { expect, test } from 'bun:test'
import { globRegexes, jsRegExp, reportOf } from '../src/adapters/nix.ts'
import { viteTask } from '../src/adapters/vite-task.ts'

test('Vite Task’s last-run summary reads as a hit, with no time of its own', async () => {
  const out = `Task Details:
────────────────────────────────────────────────
  [1] a#build: ~/packages/a$ sleep 0.3 ✓
      → Cache hit - output replayed - 309ms saved
  [2] b#build: ~/packages/b$ sleep 0.3 ✓
      → Cache miss: no previous cache entry found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  expect(await viteTask.report('/', async () => out)).toEqual({
    'a#build': { cache: 'hit' },
    'b#build': { cache: 'miss' },
  })
})

test('Nix’s report: what nix-build listed to build missed, the rest was in the store', () => {
  const log = `these 2 derivations will be built:
  /s/aaa-lib-build.drv
  /s/bbb-app-build.drv
building '/s/aaa-lib-build.drv'...
`
  const drvs = {
    'lib#build': '/s/aaa-lib-build.drv',
    'app#build': '/s/bbb-app-build.drv',
    'x#y': '/s/c.drv',
  }
  expect(reportOf({ drvs, log })).toEqual({
    'lib#build': { cache: 'miss' },
    'app#build': { cache: 'miss' },
    'x#y': { cache: 'hit' },
  })
})

test('Nix’s input globs match as each glob says, from the workspace root', () => {
  const { inc, exc } = globRegexes('packages/a', [
    'src/**',
    '*.{ts,js}',
    '!src/skip.txt',
    'x/{a[,]b,c}].txt',
  ])
  const matches = (rel: string) =>
    inc.some((r) => jsRegExp(r).test(rel)) && !exc.some((r) => jsRegExp(r).test(rel))
  expect(
    [
      'packages/a/src/x/y.txt',
      'packages/a/b.ts',
      'packages/a/.c.js',
      'packages/a/x/a,b].txt',
    ].filter(matches),
  ).toHaveLength(4)
  expect(
    ['packages/a/src/skip.txt', 'packages/a/x/b.ts', 'packages/b/src/x', 'packages/ab.ts'].filter(
      matches,
    ),
  ).toEqual([])
})
