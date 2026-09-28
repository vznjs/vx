// A canonical path is `realPath` (the OS's final path): `realpathSync`
// keeps a Windows 8.3 short name that git and every other reader expand,
// so a path compared or keyed from it had two spellings (O-16, O-17).
// The sandbox's two sites are stream B's and win32 refuses the sandbox.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const SRC = path.join(import.meta.dir, '..', 'src')
const ALLOWED = new Set(['util/real-path.ts', 'exec/sandbox-runtime.ts', 'exec/sandbox-paths.ts'])

it('no source file but realPath asks realpathSync for a canonical path', () => {
  const found: string[] = []
  let scanned = 0
  for (const rel of new Bun.Glob('**/*.ts').scanSync({ cwd: SRC })) {
    scanned++
    const posix = rel.split(path.sep).join('/')
    if (ALLOWED.has(posix)) continue
    if (/\brealpathSync\b/.test(readFileSync(path.join(SRC, rel), 'utf8'))) found.push(posix)
  }
  expect(scanned).toBeGreaterThan(100)
  expect(found).toEqual([])
})
