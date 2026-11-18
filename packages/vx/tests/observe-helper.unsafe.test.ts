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
import { envFlag } from './helpers/env.js'

const dir = path.join(import.meta.dir, '..', 'src', 'sandbox', 'observe')
const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
const helper = path.join(dir, `vx-observe-${arch}`)

it('the committed binaries were built from the committed source', async () => {
  const source = await readFile(path.join(dir, 'vx-observe.c'))
  expect((await readFile(path.join(dir, 'source.sha256'), 'utf8')).trim()).toBe(
    createHash('sha256').update(source).digest('hex'),
  )
})

// Unsafe: under a sandboxed shard this test's own observer is the second
// listener of its filter chain, which the kernel refuses. Whether this
// kernel lets it listen at all; where CI requires the sandbox, it must.
const probe =
  process.platform === 'linux' && arch !== undefined
    ? Bun.spawnSync([helper, '1', '0', '/bin/sh', '-c', ':'], { stderr: 'pipe' })
    : undefined
const runs = probe?.exitCode === 0
if (probe !== undefined && !runs && envFlag('VX_REQUIRE_SANDBOX'))
  throw new Error(`vx-observe cannot run here: ${probe.stderr.toString().trim()}`)

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
    const r = await observe(false, 'cat here.txt; { read x < ./gone.txt; } 2>/dev/null; exit 3')
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

  // No shell tool calls openat2, so Python makes the raw call. Judged by
  // the call alone (its flags lie in a struct), a read that worked went
  // unreported and a refused one was named a write.
  it('judges an openat2 by its flags: a read is a read, a write a write', async () => {
    const openat2 = (file: string, flags: string) =>
      `python3 -I -c 'import ctypes,os;h=(ctypes.c_uint64*3)(${flags},0o644,0);` +
      `ctypes.CDLL(None).syscall(437,-100,b"${file}",h,24)'`
    const r = await observe(
      true,
      [
        openat2('here.txt', 'os.O_RDONLY'),
        openat2('gone.txt', 'os.O_RDONLY'),
        openat2('new.txt', 'os.O_WRONLY|os.O_CREAT'),
      ].join('; '),
    )
    expect(r.lines).toEqual([
      'openat(AT_FDCWD, "<tmp>/here.txt", O_RDONLY) = 3',
      'openat(AT_FDCWD<<tmp>>, "gone.txt", O_RDONLY) = -1 ENOENT (x)',
      'W openat2 "<tmp>/new.txt"',
    ])
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

  it('leaves out a write under a path the runtime lets every task write, but not one in the project', () => {
    const trace = [
      'W openat "/tmp/claude/t/a.txt"',
      'W unlinkat "/tmp/claude/t/../t/a.txt"',
      'W openat "/tmp/claude/ws/proj/.git/hooks/x"',
      'W openat "/tmp/claudette/b.txt"',
      'W mkdirat "/home/u/out"',
    ].join('\n')
    expect(
      observedWrites(trace, { writable: ['/tmp/claude'], within: '/tmp/claude/ws/proj' }),
    ).toEqual([
      'deny openat /tmp/claude/ws/proj/.git/hooks/x',
      'deny openat /tmp/claudette/b.txt',
      'deny mkdirat /home/u/out',
    ])
    expect(observedWrites(trace)).toHaveLength(5)
  })
})
