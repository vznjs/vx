// Every name a first-party plugin's API record holds is named in that
// package's README. 1.0 freezes what a plugin exports
// (contract-plugin-api.unsafe.test.ts holds the record); a name no README
// mentions is surface nobody was told about, so it is either documented
// or kept off the entry (tests import the module).
//
// `.unsafe`: it reads other packages, which a sandboxed task cannot.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const PACKAGES = path.resolve(import.meta.dir, '..', '..')
const RECORDS = path.join(import.meta.dir, 'contract', 'plugin-api')

/** `== function nx (src/nx/index.ts)` → `nx`. */
function recorded(text: string): string[] {
  return [...text.matchAll(/^== \S+(?: \S+)? (\S+) \(/gm)].map((m) => m[1]!)
}

/** Named in code: `` `x` ``, `` `x(…)` ``, `` `x<…>` ``, `` `x.y` ``. */
function documented(readme: string, name: string): boolean {
  return readme.includes(`\`${name}\``) || new RegExp(`\`${name}[(<.]`).test(readme)
}

describe('every plugin export is named in its README', () => {
  const records = readdirSync(RECORDS).filter((f) => f.endsWith('.txt'))

  it('reads every plugin record', () => {
    expect(records.length).toBeGreaterThanOrEqual(7)
  })

  it('reads a record line as its name, kind words skipped', () => {
    expect(
      recorded(
        '== function nx (src/nx/index.ts)\n== abstract class A (src/a.ts)\n== type T (src/t.ts)\n',
      ),
    ).toEqual(['nx', 'A', 'T'])
    expect(documented('uses `nx()` here', 'nx')).toBe(true)
    expect(documented('uses `nxCache()` here', 'nx')).toBe(false)
    expect(documented('uses nx here', 'nx')).toBe(false)
  })

  it('names none that its README leaves out', () => {
    const missing: string[] = []
    for (const file of records) {
      const pkg = file.slice(0, -'.txt'.length)
      const readme = readFileSync(path.join(PACKAGES, pkg, 'README.md'), 'utf8')
      const names = recorded(readFileSync(path.join(RECORDS, file), 'utf8'))
      expect(names.length).toBeGreaterThan(0)
      for (const name of names) if (!documented(readme, name)) missing.push(`${pkg}: ${name}`)
    }
    expect(missing).toEqual([])
  })
})
