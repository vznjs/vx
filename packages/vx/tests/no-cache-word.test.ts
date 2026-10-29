// A task with no `cache` block never consulted the cache, so its row, the
// summary legend and the markdown report all say `no-cache`
// rather than `miss` — the word a task WITH a block gets when the lookup
// found nothing. Until 2026-09-04 every uncached task read as a miss, and a
// fresh `vx init` workspace (no cache blocks at all) showed "N miss" on
// every run, which reads as a cache that never works. Both words in one
// run are the differential: the block is the only difference between the
// two tasks.
//
// Also pins the verb typo hint, which shares the edit-distance helper.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { noticed } from './helpers/notice.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

function vx(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({
    cmd: ['bun', BIN, ...args],
    cwd,
    env: { ...process.env, NO_COLOR: '1', CI: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

describe('a task without a cache block is `no-cache`, never `miss`', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-no-cache-word-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
    for (const [name, cache] of [
      ['cached', "inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },"],
      ['plain', ''],
    ] as const) {
      const dir = path.join(root, 'packages', name)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
      await writeFile(path.join(dir, 'src', 'x.txt'), 'x')
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'true' }, ${cache} } } }\n`,
      )
    }
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('row words and legend agree', () => {
    const r = vx(root, ['run', 'build', '--all'])
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(r.out).toMatch(/success miss +\d+% +\d+ local +cached#build/)
    expect(r.out).toMatch(/success no-cache +\d+% +\d+ local +plain#build/)
    expect(r.out).toContain('local 1∅ 1↑')
  })

  it('a verb typo gets the same hint a task or flag typo gets', () => {
    const r = vx(root, ['rnu', 'build'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(noticed('vx: unknown command: rnu. Did you mean run? (see `vx help`)'))
    // One line and a pointer, not the full help after it.
    expect(r.err).not.toContain('Usage:')
    // Nothing near: no hint, no wrong guess.
    expect(vx(root, ['zzzzzzzz']).err).toStartWith('✗ vx  unknown command: zzzzzzzz\n')
  })
})
