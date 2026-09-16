// `cleanOutputs` deletes what `resolveOutputs` returns, and an output glob
// is taken as written — `node_modules/**` is an install task's output. Two
// directories stay off the wipe whatever the glob: `.git` and `.vx`, which
// no task produces and whose loss is unrecoverable. Until 2026-09-16 (item
// 337) a root project declaring `**` would have emptied both.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveOutputs } from '../src/cache/inputs.js'

describe('resolveOutputs never names .git or .vx', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-owg-'))
    for (const f of ['.git/HEAD', '.vx/cache/cache.db', 'node_modules/a/index.js', 'dist/a.js']) {
      await mkdir(path.dirname(path.join(root, f)), { recursive: true })
      await writeFile(path.join(root, f), f)
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a `**` output reaches node_modules and dist, never the repository or the cache', async () => {
    const files = await resolveOutputs({ projectDir: root, outputs: ['**'], nestedProjectDirs: [] })
    expect(files.map((f) => path.relative(root, f))).toEqual([
      'dist/a.js',
      'node_modules/a/index.js',
    ])
  })

  it('naming them outright is refused the same way', async () => {
    const files = await resolveOutputs({
      projectDir: root,
      outputs: ['.git/**', '.vx/**', 'dist/**'],
      nestedProjectDirs: [],
    })
    expect(files.map((f) => path.relative(root, f))).toEqual(['dist/a.js'])
  })
})
