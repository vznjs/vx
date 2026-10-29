// A hit restores over the outputs in place: each file is renamed over the
// one it replaces, so a reader of the output tree never finds a declared
// output missing or half-written, and only then do the outputs the entry
// does not hold go. The clean used to run first, and a reader polling a
// 64 MB output while ten hits restored met ENOENT on 153,336 of 204,411
// reads (Growth's parity probe, 2026-10-16); Turbo met none.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 60_000
const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

async function workspace(command: string): Promise<{ root: string; dir: string }> {
  const root = await makeWorkspace({ prefix: 'vx-in-place-' })
  made.push(root)
  const dir = await addProject(root, 'app', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: ${JSON.stringify(command)} },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
          },
        },
      }
    `,
    files: { 'src/in.txt': 'v1\n' },
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return { root, dir }
}

const SIZE = 32 * 1024 * 1024

it(
  'a reader of an output never finds it missing or short while a hit restores it',
  async () => {
    const { root, dir } = await workspace(
      `mkdir -p dist && head -c ${SIZE} /dev/urandom > dist/big.bin`,
    )
    const cacheDir = path.join(root, '.cache')
    const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${first.code}\n${first.err}`).toStartWith('0\n')
    const big = path.join(dir, 'dist', 'big.bin')
    // Same size, other bytes: the tree is stale and the hit restores.
    await writeFile(big, Buffer.alloc(SIZE, 7))

    let done = false
    const run = vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir]).finally(() => {
      done = true
    })
    let reads = 0
    let missing = 0
    let short = 0
    while (!done) {
      for (let i = 0; i < 200; i++) {
        reads++
        try {
          if (statSync(big).size !== SIZE) short++
        } catch {
          missing++
        }
      }
      await Bun.sleep(0)
    }
    const second = await run
    expect(`${second.code}\n${second.err}`).toStartWith('0\n')
    expect(second.out).toContain('1↓')
    expect(
      readFileSync(big)
        .subarray(0, 64)
        .every((b) => b === 7),
    ).toBe(false)
    expect({ missing, short, polled: reads > 0 }).toEqual({ missing: 0, short: 0, polled: true })
  },
  TIMEOUT,
)

it(
  'outputs the entry does not hold still go, and a directory it now holds as a file is replaced',
  async () => {
    const { root, dir } = await workspace(
      'mkdir -p dist && echo a > dist/a.txt && echo out > dist/out',
    )
    const cacheDir = path.join(root, '.cache')
    const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${first.code}\n${first.err}`).toStartWith('0\n')
    await mkdir(path.join(dir, 'dist', 'stale', 'deep'), { recursive: true })
    await writeFile(path.join(dir, 'dist', 'stale', 'deep', 'x.txt'), 'x\n')
    await rm(path.join(dir, 'dist', 'out'))
    await mkdir(path.join(dir, 'dist', 'out'))
    await writeFile(path.join(dir, 'dist', 'out', 'y.txt'), 'y\n')
    await writeFile(path.join(dir, 'dist', 'a.txt'), 'changed\n')

    const second = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${second.code}\n${second.err}`).toStartWith('0\n')
    expect(readFileSync(path.join(dir, 'dist', 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(path.join(dir, 'dist', 'out'), 'utf8')).toBe('out\n')
    expect(existsSync(path.join(dir, 'dist', 'stale'))).toBe(false)
  },
  TIMEOUT,
)

// turborepo test_slow_path_skips_unchanged_files: a hit rewrites only the
// outputs that changed. Renaming over every file cost a 2,000-file restore
// ~0.4 ms a file on ext4 (auto_da_alloc), changed or not.
it(
  'a hit leaves the outputs it would write unchanged as they are',
  async () => {
    const { root, dir } = await workspace(
      'mkdir -p dist && echo a > dist/a.txt && echo b > dist/b.txt',
    )
    const cacheDir = path.join(root, '.cache')
    const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${first.code}\n${first.err}`).toStartWith('0\n')
    const a = path.join(dir, 'dist', 'a.txt')
    const before = statSync(a)
    await writeFile(path.join(dir, 'dist', 'b.txt'), 'changed\n')
    const second = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${second.code}\n${second.err}`).toStartWith('0\n')
    expect(second.out).toContain('1\u2193')
    expect(readFileSync(path.join(dir, 'dist', 'b.txt'), 'utf8')).toBe('b\n')
    const after = statSync(a)
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
  },
  TIMEOUT,
)

it(
  'a restore temp a killed run left beside an exact-file output goes on the next run that writes it',
  async () => {
    const { root, dir } = await workspace('mkdir -p out && echo a > out/a.txt')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: {
        exec: { command: 'mkdir -p out && echo a > out/a.txt' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out/a.txt'] } },
      } } }`,
    )
    const cacheDir = path.join(root, '.cache')
    await mkdir(path.join(dir, 'out'), { recursive: true })
    // A pid above any pid_max: its run is gone. This test's own pid is live.
    const dead = path.join(dir, 'out', '.vx-tmp-zzzzzz-1')
    const live = path.join(dir, 'out', `.vx-tmp-${process.pid.toString(36)}-1`)
    await writeFile(dead, 'partial')
    await writeFile(live, 'in flight')
    const miss = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${miss.code}\n${miss.err}`).toStartWith('0\n')
    expect([existsSync(dead), existsSync(live)]).toEqual([false, true])

    await writeFile(dead, 'partial')
    await writeFile(path.join(dir, 'out', 'a.txt'), 'changed\n')
    const hit = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${hit.code}\n${hit.err}`).toStartWith('0\n')
    expect(hit.out).toContain('1↓')
    expect([existsSync(dead), existsSync(live)]).toEqual([false, true])
  },
  TIMEOUT,
)

// Turbo stopped hard-linking cache entries (vercel/turborepo#1354): an
// output edited in place after a save or a restore rewrote the entry, and
// the next hit replayed the edit.
it(
  'an output edited in place after a save or a restore leaves the entry as saved',
  async () => {
    // Past the store's inline size, so the entry is a file of its own.
    const { root, dir } = await workspace(
      'mkdir -p dist && yes built | head -c 65536 > dist/out.txt',
    )
    const cacheDir = path.join(root, '.cache')
    const out = path.join(dir, 'dist', 'out.txt')
    const hit = async (): Promise<string> => {
      await rm(path.join(dir, 'dist'), { recursive: true })
      const r = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
      expect(`${r.code}\n${r.err}`).toStartWith('0\n')
      expect(r.out).toContain('1↓')
      return readFileSync(out, 'utf8')
    }
    const first = await vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
    expect(`${first.code}\n${first.err}`).toStartWith('0\n')
    const built = readFileSync(out, 'utf8')
    await appendFile(out, 'after save\n')
    expect(await hit()).toBe(built)
    await appendFile(out, 'after restore\n')
    expect(await hit()).toBe(built)
  },
  TIMEOUT,
)
