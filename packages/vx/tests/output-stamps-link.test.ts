// A link standing in an output file's place when a restore's stamps are taken
// (another process swapped it in just after the restore wrote the file) was
// stamped with its target's stat: same size, mode and dated mtime. Every later
// run called the tree current and kept the link, a green hit over wrong bytes
// (found 11-18 by a probe damaging outputs while a run restored them).

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'

let root = ''
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('a link swapped in before the stamps is never stamped current', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-stamp-link-'))
  const proj = path.join(root, 'proj')
  mkdirSync(path.join(proj, 'dist'), { recursive: true })
  const cache = new Cache(path.join(root, 'cache'), { read: true, write: true })
  try {
    const at = new Date(1_700_000_000_123)
    for (const f of ['f0', 'f1']) {
      writeFileSync(path.join(proj, 'dist', `${f}.txt`), `v-${f}\n`)
      utimesSync(path.join(proj, 'dist', `${f}.txt`), at, at)
    }
    await cache.save({
      hash: 'stamp-link',
      entry: { taskId: 'p#build', command: 'noop', durationMs: 1, stdout: '' },
      projectDir: proj,
      outputFiles: ['f0', 'f1'].map((f) => path.join(proj, 'dist', `${f}.txt`)),
    })
    const out = path.join(root, 'out')
    mkdirSync(out)
    await cache.restoreOutputs('stamp-link', out)
    const f1 = path.join(out, 'dist', 'f1.txt')
    rmSync(f1)
    symlinkSync('f0.txt', f1)
    cache.memo.recordOutputStamps('stamp-link', out, root)
    const rows = cache.memo.loadOutputFilesBatch(['stamp-link']).get('stamp-link') ?? []
    expect(readFileSync(f1, 'utf8')).toBe('v-f0\n')
    expect(cache.memo.isOutputsCurrent(out, rows)).toBe(false)
  } finally {
    cache.close()
  }
})
