// On Linux a write grant naming a file binds its directory (bwrap cannot
// rename onto a file mount), and a read there is never refused: a task
// granted `write: ['out.txt']` read an undeclared `secret.txt` unreported,
// and a cached run replayed its old bytes. Such a read is now reported
// from the trace when it succeeds.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { deniedCalls } from '../src/exec/sandbox-violations.js'
import { sandboxFix } from '../src/orchestrator/sandbox-fix.js'
import { relPosix } from '../src/util/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

describe('deniedCalls › reads', () => {
  const trace = [
    '10 openat(AT_FDCWD, "a.txt", O_RDONLY|O_CLOEXEC) = 3',
    '10 openat(AT_FDCWD, "out.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 4',
    '10 openat(AT_FDCWD, "rw.txt", O_RDWR) = 5',
    '10 openat(7, "rel.txt", O_RDONLY) = 6',
    '10 openat(7, "/abs.txt", O_RDONLY) = 6',
    '10 openat(AT_FDCWD, "split.txt", O_RDONLY <unfinished ...>',
    '10 <... openat resumed>) = 8',
    '10 openat(AT_FDCWD, "gone.txt", O_RDONLY) = -1 ENOENT (No such file or directory)',
    '',
  ].join('\n')

  it('are the successful opens not for writing alone, by the cwd or an absolute path', () => {
    expect(deniedCalls(trace, '/ws', true).map((c) => [c.rawPath, c.errno, c.read])).toEqual([
      ['a.txt', '', true],
      ['rw.txt', '', true],
      ['/abs.txt', '', true],
      ['split.txt', '', true],
      ['gone.txt', 'ENOENT', undefined],
    ])
  })

  it('with -y, are placed by the path the returned descriptor names', () => {
    const y = [
      '10 openat(4</ws/p/sub>, "f", O_RDONLY|O_NOFOLLOW) = 3</ws/p/sub/f>',
      '10 openat(AT_FDCWD</ws/p>, "g", O_RDONLY <unfinished ...>',
      '10 <... openat resumed>) = 5</ws/p/g>',
      '10 openat(4</ws/p/sub>, "h", O_RDONLY <unfinished ...>',
      '10 <... openat resumed>) = 6</ws/p/sub/h>',
      '10 openat(AT_FDCWD</ws/p>, "out", O_WRONLY|O_CREAT, 0666) = 7</ws/p/out>',
      '',
    ].join('\n')
    expect(deniedCalls(y, '/ws', true).map((c) => c.rawPath)).toEqual([
      '/ws/p/sub/f',
      '/ws/p/g',
      '/ws/p/sub/h',
    ])
  })

  // musl's open() is the `open` syscall, which names no directory.
  it('are the open calls too, read or refused', () => {
    const calls = [
      '10 open("o.txt", O_RDONLY) = 3</ws/o.txt>',
      '10 open("p.txt", O_RDONLY) = 3',
      '10 open("w.txt", O_WRONLY|O_CREAT, 0644) = 4</ws/w.txt>',
      '10 open("s.txt", O_RDONLY <unfinished ...>',
      '10 <... open resumed>) = 7</ws/s.txt>',
      '10 open("gone.txt", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(calls, '/ws', true).map((c) => [c.syscall, c.rawPath, c.errno])).toEqual([
      ['open', '/ws/o.txt', ''],
      ['open', 'p.txt', ''],
      ['open', '/ws/s.txt', ''],
      ['open', 'gone.txt', 'ENOENT'],
    ])
  })

  // git hashes a link by its target string, which `readlink` reads with no open.
  it('are the readlink calls too, read or refused, placed as the opens are', () => {
    const calls = [
      '10 readlink("cfg", "v1", 64) = 2',
      '10 readlinkat(4</ws/p/sub>, "l2", "t", 4095) = 1',
      '10 readlinkat(AT_FDCWD, "split", <unfinished ...>',
      '10 <... readlinkat resumed>"t", 4095) = 1',
      '10 readlink("gone", 0x5592db3d82f0, 64) = -1 ENOENT (No such file or directory)',
      '10 readlink("plain.txt", 0x5592db3d82f0, 64) = -1 EINVAL (Invalid argument)',
      '',
    ].join('\n')
    const seen = (reads: boolean) =>
      deniedCalls(calls, '/ws', reads).map((c) => [c.syscall, c.rawPath, c.dir, c.errno])
    expect(seen(true)).toEqual([
      ['readlink', 'cfg', undefined, ''],
      ['readlinkat', 'l2', '/ws/p/sub', ''],
      ['readlinkat', 'split', undefined, ''],
      ['readlink', 'gone', undefined, 'ENOENT'],
    ])
    expect(seen(false)).toEqual([['readlink', 'gone', undefined, 'ENOENT']])
  })

  it('CONTROL: are not asked for, and only the denial comes back', () => {
    expect(deniedCalls(trace, '/ws').map((c) => c.rawPath)).toEqual(['gone.txt'])
  })
})

const available = await sandboxAvailable('sandbox widened-reads test')

describe.skipIf(!available || process.platform !== 'linux')(
  'a read under a widened write grant',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-widened-')))
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const run = async (command: string, write: string[]) => {
      const proj = path.join(dir, 'proj')
      await mkdir(path.join(proj, 'src'), { recursive: true })
      await mkdir(path.join(proj, 'dist'), { recursive: true })
      await writeFile(path.join(proj, 'src', 'a.txt'), 'a')
      await writeFile(path.join(proj, 'secret.txt'), 's')
      await writeFile(path.join(proj, 'dist', 'old.txt'), 'o')
      return runSandboxed({
        command,
        cwd: proj,
        env: process.env,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { read: ['src/**'], write } }, proj),
      })
    }

    it('is reported when no grant covers it; the input and the output are not', async () => {
      const r = await run('cat src/a.txt secret.txt > out.txt; cat out.txt', ['out.txt'])
      expect([r.exitCode, r.stdout, r.violations.map((v) => v.target)]).toEqual([
        0,
        'as',
        [path.join(dir, 'proj', 'secret.txt')],
      ])
    })

    // The raw `open` syscall, musl's open(): x64 has it, arm64 has none.
    it.skipIf(process.arch !== 'x64')('is reported when opened by the open syscall', async () => {
      // perl's syscall() takes its string argument as a writable buffer.
      const open = `my $p = "secret.txt"; syscall(2, $p, 0) >= 0 or exit 1`
      const r = await run(`perl -e '${open}' && touch out.txt`, ['out.txt'])
      expect([r.exitCode, r.violations.map((v) => v.line.split('(')[0] + ' ' + v.target)]).toEqual([
        0,
        [`open ${path.join(dir, 'proj', 'secret.txt')}`],
      ])
    })

    it("reports the directory's own listing, which names every sibling", async () => {
      const r = await run('ls > out.txt', ['out.txt'])
      expect([r.exitCode, r.violations.map((v) => v.target)]).toEqual([0, [path.join(dir, 'proj')]])
    })

    it('is reported when read through a directory descriptor (grep -r, find)', async () => {
      const r = await run('grep -r -l . . > out.txt; true', ['out.txt'])
      expect(r.violations.map((v) => String(v.target)).sort((a, b) => a.localeCompare(b))).toEqual([
        path.join(dir, 'proj'),
        ...['dist', 'dist/old.txt', 'secret.txt'].map((f) => path.join(dir, 'proj', f)),
      ])
    })

    it('a file the task made there is its own: not reported', async () => {
      const r = await run('echo t > s.tmp; cat s.tmp src/a.txt > out.txt; rm s.tmp', ['out.txt'])
      expect([r.exitCode, r.violations]).toEqual([0, []])
    })

    it('the declared file, there from an earlier run, is its own (tsc re-reads its .tsbuildinfo)', async () => {
      await mkdir(path.join(dir, 'proj'), { recursive: true })
      await writeFile(path.join(dir, 'proj', 'out.txt'), 'earlier')
      const r = await run('cat out.txt src/a.txt > next.tmp && mv next.tmp out.txt', ['out.txt'])
      expect([r.exitCode, r.violations]).toEqual([0, []])
    })

    it('CONTROL: a directory grant is not widened, and reads inside it are its own', async () => {
      const r = await run('cat src/a.txt dist/old.txt > dist/out.txt', ['dist/'])
      expect([r.exitCode, r.violations]).toEqual([0, []])
    })

    // The directory is writable too, and a hard link reads without an
    // open: `ln -f secret.txt out.txt` passed unreported and cached the
    // secret's bytes, replayed after it changed; a write to a sibling
    // landed on the host unreported.
    const targets = (r: { violations: { target?: string }[] }): string[] =>
      [...new Set(r.violations.map((v) => relPosix(path.join(dir, 'proj'), v.target!)))].sort()

    it('a hard link of a sibling no grant covers is reported, and named for a read', async () => {
      const r = await run('ln -f secret.txt out.txt', ['out.txt'])
      expect([r.exitCode, targets(r)]).toEqual([0, ['secret.txt']])
      expect(
        sandboxFix(r.violations, path.join(dir, 'proj'), dir, undefined, { files: ['src/**'] }),
      ).toEqual({
        read: ['secret.txt'],
        inputs: ['secret.txt'],
      })
    })

    it('a move of a sibling no grant covers is reported', async () => {
      const r = await run('mv secret.txt out.txt', ['out.txt'])
      expect(targets(r)).toEqual(['secret.txt'])
    })

    it('a write, removal or overwrite of what was there is reported', async () => {
      const r = await run(
        'echo x > secret.txt; rm dist/old.txt; echo z > src/a.txt; echo y > out.txt',
        ['out.txt'],
      )
      expect(targets(r)).toEqual(['dist/old.txt', 'secret.txt', 'src/a.txt'])
    })

    it('a file the task made there and left is reported; one it moved or removed is not', async () => {
      const r = await run(
        'echo t > left.txt; mkdir d; echo t > s.tmp; mv s.tmp out.txt; echo t > r.tmp; rm r.tmp',
        ['out.txt'],
      )
      expect(targets(r)).toEqual(['d', 'left.txt'])
    })

    it('CONTROL: a granted input linked, an existing directory made, a staged output', async () => {
      const r = await run(
        'mkdir -p src dist; ln -f src/a.txt a.tmp; cat a.tmp > s.tmp; rm a.tmp; mv s.tmp out.txt',
        ['out.txt'],
      )
      expect([r.exitCode, r.violations]).toEqual([0, []])
    })

    // A link's bytes in git are its target string, and `readlink` reads it
    // with no open: `readlink cfg > out.txt` cached `v1` and replayed it
    // after `cfg` pointed at `v2`.
    it('a readlink of a sibling link no grant covers is reported, and named for a read', async () => {
      await mkdir(path.join(dir, 'proj'), { recursive: true })
      await symlink('v1', path.join(dir, 'proj', 'cfg'))
      const r = await run('readlink cfg > out.txt', ['out.txt'])
      expect([r.exitCode, targets(r)]).toEqual([0, ['cfg']])
      expect(
        sandboxFix(r.violations, path.join(dir, 'proj'), dir, undefined, { files: ['src/**'] }),
      ).toEqual({
        read: ['cfg'],
        inputs: ['cfg'],
      })
    })

    it('a readlink of a link the sandbox hides is reported as a refused read', async () => {
      await mkdir(path.join(dir, 'proj'), { recursive: true })
      await symlink('v1', path.join(dir, 'proj', 'cfg'))
      const r = await run('readlink cfg > dist/out.txt || echo none > dist/out.txt', ['dist/'])
      expect([r.exitCode, targets(r), r.violations.map((v) => v.ignorable)]).toEqual([
        0,
        ['cfg'],
        [['read']],
      ])
    })

    it('CONTROL: a readlink of a granted link, or of a missing path, is not reported', async () => {
      await mkdir(path.join(dir, 'proj', 'src'), { recursive: true })
      await symlink('v1', path.join(dir, 'proj', 'src', 'cfg'))
      const r = await run('readlink src/cfg > out.txt; readlink nope; true', ['out.txt'])
      expect([r.exitCode, r.violations]).toEqual([0, []])
    })
  },
)
