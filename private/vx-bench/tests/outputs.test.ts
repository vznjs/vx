import { expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deleteDist, missingDist } from '../outputs.js'

it('names each package without dist/index.js, and none once all are restored', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-bench-outputs-'))
  try {
    for (const p of ['a', 'b', 'c']) {
      await mkdir(path.join(dir, 'packages', p, 'dist'), { recursive: true })
      await writeFile(path.join(dir, 'packages', p, 'package.json'), '{}')
      await writeFile(path.join(dir, 'packages', p, 'dist', 'index.js'), '')
    }
    expect(await missingDist(dir)).toEqual([])
    expect(await missingDist(dir, 'out.js')).toEqual(['packages/a', 'packages/b', 'packages/c'])
    await rm(path.join(dir, 'packages', 'b', 'dist', 'index.js'))
    expect(await missingDist(dir)).toEqual(['packages/b'])
    await deleteDist(dir)
    expect(await missingDist(dir)).toEqual(['packages/a', 'packages/b', 'packages/c'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
