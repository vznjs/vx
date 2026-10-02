// A file URL's `.pathname` is percent-encoded, not a path: a checkout
// under a directory holding a space reads ENOENT under it (O-6). A path
// comes from `import.meta.dir`, `fileURLToPath`, or `Bun.file(url)` itself.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const FILE_URL_PATHNAME = /import\.meta\.url\)\s*\.pathname/

describe('no path in core is read off a file URL’s pathname', () => {
  it('the pattern catches the shape it names', () => {
    // CONTROL: without this, a pattern that matches nothing passes the law.
    expect(FILE_URL_PATHNAME.test("new URL('../docs/cli.md', import.meta.url).pathname")).toBe(true)
    expect(FILE_URL_PATHNAME.test('path.dirname(new URL(import.meta.url).pathname)')).toBe(true)
    expect(FILE_URL_PATHNAME.test('new URL(req.url).pathname')).toBe(false)
  })

  it('no file in src, tests or scripts uses it', () => {
    const found: string[] = []
    let scanned = 0
    for (const dir of ['src', 'tests', 'scripts']) {
      for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: path.join(ROOT, dir) })) {
        scanned++
        const text = readFileSync(path.join(ROOT, dir, rel), 'utf8')
        if (rel.endsWith('file-url-paths.test.ts')) continue
        if (FILE_URL_PATHNAME.test(text)) found.push(`${dir}/${rel.split(path.sep).join('/')}`)
      }
    }
    expect(scanned).toBeGreaterThan(300)
    expect(found).toEqual([])
  })
})
