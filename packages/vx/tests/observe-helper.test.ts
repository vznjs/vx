// The observer's binaries are committed (`scripts/build-observe.ts`), so a
// change to its source that was never built would ship the old program.
// And the program itself, with no sandbox around it: what it prints is
// what `violations.ts` parses.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deniedCalls, observedWrites } from '../src/sandbox/violations.js'

const dir = path.join(import.meta.dir, '..', 'src', 'sandbox', 'observe')
const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
const helper = path.join(dir, `vx-observe-${arch}`)

it('the committed binaries were built from the committed source', async () => {
  const source = await readFile(path.join(dir, 'vx-observe.c'))
  expect((await readFile(path.join(dir, 'source.sha256'), 'utf8')).trim()).toBe(
    createHash('sha256').update(source).digest('hex'),
  )
})

// Whether this kernel and this process's own sandbox let it listen at all.
const runs =
  process.platform === 'linux' &&
  arch !== undefined &&
  Bun.spawnSync([helper, '1', '0', '/bin/sh', '-c', ':'], { stderr: 'ignore' }).exitCode === 0

describe.skipIf(!runs)('vx-observe', () => {
  const observe = async (reads: boolean, script: string) => {
    const tmp = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-observe-helper-')))
    await writeFile(path.join(tmp, 'here.txt'), 'here\n')
    const log = path.join(tmp, 'log')
    const p = Bun.spawn(
      ['/bin/sh', '-c', `exec "$0" 5 ${reads ? 1 : 0} /bin/sh -c "$1" 5>"$2"`, helper, script, log],
      { cwd: tmp, stdout: 'pipe', stderr: 'pipe' },
    )
    const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited])
    const raw = await readFile(log, 'utf8')
    const lines = raw
      .split('\n')
      .filter((l) => l.includes(tmp))
      .map((l) => l.replace(/^\d+ /, '').replaceAll(tmp, '<tmp>'))
    await rm(tmp, { recursive: true, force: true })
    return { stdout, exitCode, lines, raw, tmp }
  }

  it('prints a failed read as strace -y does, the path as spelled, and no read that worked', async () => {
    const r = await observe(false, 'cat here.txt; cat ./gone.txt 2>/dev/null; exit 3')
    expect({ stdout: r.stdout, exitCode: r.exitCode, lines: r.lines }).toEqual({
      stdout: 'here\n',
      exitCode: 3,
      lines: ['openat(AT_FDCWD<<tmp>>, "./gone.txt", O_RDONLY) = -1 ENOENT (x)'],
    })
  })

  // x86_64's readlink() takes no directory; aarch64 has only readlinkat.
  it('names a relative path’s directory, by a chdir line where the call takes none', async () => {
    const r = await observe(false, 'readlink gone 2>/dev/null; exit 0')
    const calls = deniedCalls(r.raw, '/elsewhere').filter((c) => !c.rawPath.startsWith('/'))
    expect(calls.map((c) => [c.rawPath, c.dir, c.errno])).toEqual([['gone', r.tmp, 'ENOENT']])
  })

  it('asked for reads, prints the ones that worked too', async () => {
    const r = await observe(true, 'cat here.txt >/dev/null')
    expect(r.lines).toEqual(['openat(AT_FDCWD, "<tmp>/here.txt", O_RDONLY) = 3'])
  })

  it('prints each write-intent call, a move as its source then its destination', async () => {
    const r = await observe(false, 'echo x > "a b.txt" && mv "a b.txt" c.txt && rm c.txt')
    expect(observedWrites(r.lines.join('\n')).map((l) => l.replace(/^deny \S+ /, ''))).toEqual([
      '<tmp>/a b.txt',
      '<tmp>/a b.txt',
      '<tmp>/c.txt',
      '<tmp>/c.txt',
    ])
  })
})
