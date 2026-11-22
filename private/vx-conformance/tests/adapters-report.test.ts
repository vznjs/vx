import { expect, test } from 'bun:test'
import { globRegexes, jsRegExp, reportOf } from '../src/adapters/nix.ts'
import { viteTask } from '../src/adapters/vite-task.ts'
import { vx } from '../src/adapters/vx.ts'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// A run follows the lock: `vx lock` is the step after a manifest edit, and a
// config in a package with no task is one no vx user writes (in a folder git
// ignores, `vx lock` refuses it).
test('vx relocks after a manifest edit and writes no config for a task-less package', async () => {
  expect(vx.edited).toEqual([['node_modules/.bin/vx', 'lock']])
  const dir = await mkdtemp(path.join(os.tmpdir(), 'conf-vx-adapter-'))
  try {
    await mkdir(path.join(dir, 'packages/a/gen/sub'), { recursive: true })
    await vx.configure(
      dir,
      {
        projects: {
          a: { tasks: { build: { command: 'true', inputs: ['src/**'] } } },
          sub: { dir: 'packages/a/gen/sub' },
        },
      },
      () => 'true',
    )
    expect(existsSync(path.join(dir, 'packages/a/vx.config.mjs'))).toBe(true)
    expect(existsSync(path.join(dir, 'packages/a/gen/sub/vx.config.mjs'))).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

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

test('a `.` segment in a Nix input glob is the directory it sits in', () => {
  const { inc, exc } = globRegexes('packages/a', ['*/.', '!gen/.', './src/./x'])
  const matches = (rel: string) =>
    inc.some((r) => jsRegExp(r).test(rel)) && !exc.some((r) => jsRegExp(r).test(rel))
  expect(
    ['packages/a/src/a.txt', 'packages/a/gen/g.txt', 'packages/a/src/x'].filter(matches),
  ).toEqual(['packages/a/src/a.txt', 'packages/a/src/x'])
})
