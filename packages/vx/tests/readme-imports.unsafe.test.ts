// A README sample a reader copies must import what the package exports: a
// renamed factory left a README importing a name that no longer exists.
// Each `import { … } from '@vzn/…'` in the package READMEs and the root
// README names a value export of that module (types are the API page's).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')

it('every value a README imports from @vzn/* is exported there', async () => {
  const readmes = [
    path.join(REPO, 'README.md'),
    ...readdirSync(path.join(REPO, 'packages'))
      .map((p) => path.join(REPO, 'packages', p, 'README.md'))
      .filter((f) => existsSync(f)),
  ]
  const missing: string[] = []
  let checked = 0
  for (const file of readmes) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/import\s+\{([^}]+)\}\s+from\s+'(@vzn\/[\w\-/]+)'/g)) {
      // Core names no plugin as a dependency: each package resolves itself.
      const owner = path.join(REPO, 'packages', m[2]!.slice('@vzn/'.length).split('/')[0]!)
      const exported = new Set(Object.keys((await import(Bun.resolveSync(m[2]!, owner))) as object))
      for (const raw of m[1]!.split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0]!
        // A type has no runtime export; by convention it is capitalised.
        if (name === '' || name.startsWith('type ') || /^[A-Z]/.test(name)) continue
        checked++
        if (!exported.has(name)) missing.push(`${path.relative(REPO, file)}: ${m[2]} ${name}`)
      }
    }
  }
  expect(checked).toBeGreaterThan(10)
  expect(missing).toEqual([])
})
