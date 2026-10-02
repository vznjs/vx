// On Linux a write grant naming a file binds its directory (bwrap cannot
// rename onto a file mount), and a read there is never refused: a task
// granted `write: ['out.txt']` read an undeclared `secret.txt` unreported,
// and a cached run replayed its old bytes. Such a read is now reported
// from the trace when it succeeds.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { deniedCalls } from '../src/exec/sandbox-violations.js'
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
      const r = await run('echo t > stage.tmp; cat stage.tmp src/a.txt > out.txt', ['out.txt'])
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
  },
)
