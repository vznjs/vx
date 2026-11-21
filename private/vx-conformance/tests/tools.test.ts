import { expect, test } from 'bun:test'
import pkg from '../package.json'
import { LATEST, modulesOf } from '../src/tools.ts'

// The rivals run at npm's latest, installed inside the run, never a pin
// (2026-11-21): a pin left in package.json would be the version scored.
test('no tool under test is pinned, and none resolves before the install', () => {
  const pinned = Object.keys(pkg.devDependencies).filter((d) => LATEST.includes(d))
  expect(pinned).toEqual([])
  for (const p of LATEST) expect(() => modulesOf(p)).toThrow('installLatest() first')
  expect(modulesOf('@vzn/vx')).toEndWith('node_modules')
})
