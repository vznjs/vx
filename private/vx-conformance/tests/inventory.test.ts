import path from 'node:path'
import { expect, test } from 'bun:test'
import { CASES } from '../cases/index.ts'
import { INVENTORY } from '../src/inventory.ts'
import { ref } from '../src/report.ts'

const PACKAGES = path.join(import.meta.dir, '..', '..', '..', 'packages')

/** Every test file of every package, named as the inventory names it. */
function testFiles(): string[] {
  return [...new Bun.Glob('*/tests/*.test.ts').scanSync(PACKAGES)]
    .map((f) => {
      const [pkg, , file] = f.split('/') as [string, string, string]
      const name = file.slice(0, -'.test.ts'.length)
      return pkg === 'vx' ? name : `${pkg}/${name}`
    })
    .sort()
}

test('every test file is in exactly one list', () => {
  const listed = Object.values(INVENTORY).flat()
  const twice = listed.filter((f, i) => listed.indexOf(f) !== i)
  expect(twice).toEqual([])
  const files = testFiles()
  expect(files.filter((f) => !listed.includes(f))).toEqual([])
  expect(listed.filter((f) => !files.includes(f))).toEqual([])
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
