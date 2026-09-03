// The gate's test stage is four shards dealt by tests/helpers/shard-deal.ts.
// A wrong deal is silent: a shard merely runs slower, or an isolated file
// shares a process and the descriptor cap bites a file that sorts after it.
// These pins hold the three rules over a synthetic tests directory.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { dealShards, describeTestFile, shardGroups } from './helpers/shard-deal.js'

describe('shard dealing', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-shard-deal-'))
    const w = (name: string, body: string) => writeFile(path.join(dir, name), body)
    await w('big.test.ts', '// @vx-shard-cost 40\nexport {}\n') // tiny on disk, huge by hint
    await w('hungry.test.ts', '// @vx-shard-cost 7\n// @vx-shard-isolate\nexport {}\n')
    await w('medium.test.ts', 'x'.repeat(50_000)) // 5 by size
    await w('small-a.test.ts', 'x'.repeat(10_000)) // 1 by size
    await w('small-b.test.ts', 'x'.repeat(10_000)) // 1 by size
    await w('helper.ts', 'export {}\n') // not a test file
    await w('notes.md', '// @vx-shard-cost 999\n') // not a test file
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('a cost hint beats file size, and the isolate hint is read from the head', () => {
    expect(describeTestFile(dir, 'big.test.ts')).toEqual({
      rel: './tests/big.test.ts',
      cost: 40,
      isolate: false,
    })
    expect(describeTestFile(dir, 'medium.test.ts').cost).toBe(5)
    expect(describeTestFile(dir, 'hungry.test.ts')).toEqual({
      rel: './tests/hungry.test.ts',
      cost: 7,
      isolate: true,
    })
  })

  it('deals longest-first: the heaviest file gets a shard to itself when it outweighs the rest', () => {
    const shards = dealShards(dir, 2)
    const names = shards.map((s) => s.map((f) => path.basename(f.rel)).sort())
    expect(names[0]).toEqual(['big.test.ts'])
    expect(names[1]).toEqual([
      'hungry.test.ts',
      'medium.test.ts',
      'small-a.test.ts',
      'small-b.test.ts',
    ])
  })

  it('every test file lands in exactly one shard, and only test files are dealt', () => {
    for (const n of [1, 3, 7]) {
      const all = dealShards(dir, n)
        .flat()
        .map((f) => path.basename(f.rel))
        .sort()
      expect(all).toEqual([
        'big.test.ts',
        'hungry.test.ts',
        'medium.test.ts',
        'small-a.test.ts',
        'small-b.test.ts',
      ])
    }
  })

  it('an isolated file gets a bun test process of its own; the rest share one', () => {
    const shard = dealShards(dir, 1)[0]!
    const groups = shardGroups(shard).map((g) => g.map((rel) => path.basename(rel)).sort())
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual([
      'big.test.ts',
      'medium.test.ts',
      'small-a.test.ts',
      'small-b.test.ts',
    ])
    expect(groups[1]).toEqual(['hungry.test.ts'])
    // A shard holding only the isolated file is one group, not one plus an empty one.
    expect(shardGroups(shard.filter((f) => f.isolate))).toEqual([['./tests/hungry.test.ts']])
  })
})

// The runner itself, over the real tests directory: an empty shard is a
// refusal (exit 2), never a silent green.
describe('shard runner CLI', () => {
  const cli = path.resolve(import.meta.dir, 'helpers/shard.ts')
  it('refuses to run a shard that received no files', () => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, cli, 'run', '200', '199'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(p.exitCode).toBe(2)
    expect(p.stderr.toString()).toContain('shard 199 of 200 has no files')
  })
  it('CONTROL: a shard that received files lists them', () => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, cli, 'list', '200', '0'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString().trim()).toMatch(/^\.\/tests\/.+\.test\.ts$/)
  })
})
