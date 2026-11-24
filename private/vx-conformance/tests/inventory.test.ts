import path from 'node:path'
import { expect, test } from 'bun:test'
import { CASES } from '../cases/index.ts'
import { INVENTORY } from '../src/inventory.ts'
import { ref } from '../src/report.ts'

const ROOT = path.join(import.meta.dir, '..', '..', '..')

/**
 * Every test file of every package, shipped (`packages/`) or not
 * (`private/`), at any depth, named as the inventory names it: core's bare,
 * another's `<dir>/<path>` from its package dir, `tests/` and `.test.ts` off
 * (`vx-docs/site-build`, `vx-plugin-examples/plugins/budget`). Only the top
 * level of `packages/*\/tests` was read: 94 files under `private/` were in
 * no list (2026-11-24).
 */
function testFiles(): string[] {
  const out: string[] = []
  for (const top of ['packages', 'private'])
    for (const f of new Bun.Glob('*/**/*.test.{ts,tsx,js,mjs,cjs,mts}').scanSync(
      path.join(ROOT, top),
    )) {
      if (f.split('/').includes('node_modules')) continue
      const [pkg, ...rest] = f.split('/')
      const name = rest
        .join('/')
        .replace(/^tests\//, '')
        .replace(/\.test\.\w+$/, '')
      out.push(top === 'packages' && pkg === 'vx' ? name : `${pkg}/${name}`)
    }
  return out.sort()
}

test('the inventory reads every package, private ones and nested files too', () => {
  const files = testFiles()
  expect(files).toContain('parity-turbo')
  expect(files).toContain('vx-dte/units')
  expect(files.some((f) => f.startsWith('vx-docs/'))).toBe(true)
  expect(files.some((f) => /^vx-plugin-examples\/\w+\//.test(f))).toBe(true)
})

test('every test file is in exactly one list', () => {
  const listed = Object.values(INVENTORY).flat()
  const twice = listed.filter((f, i) => listed.indexOf(f) !== i)
  expect(twice).toEqual([])
  const files = testFiles()
  // Each line says the fix, so a new test file's author needs no lookup.
  const lists = Object.keys(INVENTORY).join(' | ')
  expect(
    files
      .filter((f) => !listed.includes(f))
      .map((f) => `add '${f}', to one list (${lists}) of private/vx-conformance/src/inventory.ts`),
  ).toEqual([])
  expect(
    listed
      .filter((f) => !files.includes(f))
      .map((f) => `remove '${f}', from private/vx-conformance/src/inventory.ts: no such test file`),
  ).toEqual([])
})

test('every case cites test files that exist', () => {
  const files = new Set(testFiles())
  const unknown = CASES.flatMap((c) =>
    c.from.filter((f) => !files.has(f)).map((f) => `${c.id}: ${f}`),
  )
  expect(unknown).toEqual([])
})

// A link or a filed issue names a case by its ref; two cases sharing one
// would make it name both. A new case that collides takes another slug.
test('every case has its own short ref, six characters of a URL', () => {
  const refs = CASES.map((c) => ref(c.id))
  expect(refs.filter((r, i) => refs.indexOf(r) !== i)).toEqual([])
  expect(refs.filter((r) => !/^[a-z0-9]{6}$/.test(r))).toEqual([])
  expect(ref('graph/deps-first')).toBe('e5a1q0')
})

test('every case has a unique id under its category and cites a source', () => {
  const ids = CASES.map((c) => c.id)
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  for (const c of CASES) {
    expect(c.id.startsWith(`${c.category}/`)).toBe(true)
    expect(c.from.length).toBeGreaterThan(0)
  }
})
