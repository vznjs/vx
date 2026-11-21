import { expect, test } from 'bun:test'
import pkg from '../package.json'
import { CASES } from '../cases/index.ts'
import { turbo } from '../src/adapters/turbo.ts'
import { runCase } from '../src/harness.ts'
import { sandboxAvailable } from '../src/sandbox.ts'
import { installLatest, LATEST, modulesOf } from '../src/tools.ts'

// The rivals run at npm's latest, installed inside the run, never a pin
// (2026-11-21): a pin left in package.json would be the version scored.
test('no tool under test is pinned, and none resolves before the install', () => {
  const pinned = Object.keys(pkg.devDependencies).filter((d) => LATEST.includes(d))
  expect(pinned).toEqual([])
  for (const p of LATEST) expect(() => modulesOf(p)).toThrow('installLatest() first')
  expect(modulesOf('@vzn/vx')).toEndWith('node_modules')
})

// Installed under the host's /tmp, every rival run failed "bwrap: execvp
// node_modules/.bin/turbo: No such file or directory": the sandbox mounts
// a /tmp of its own over it.
test.skipIf(!sandboxAvailable() && !process.env['VX_REQUIRE_SANDBOX'])(
  'a rival installed at latest runs inside the sandbox',
  async () => {
    await installLatest(['turbo'])
    const c = CASES.find((x) => x.id === 'graph/deps-first')!
    expect(await runCase(c, turbo)).toMatchObject({ status: 'pass' })
  },
  120_000,
)
