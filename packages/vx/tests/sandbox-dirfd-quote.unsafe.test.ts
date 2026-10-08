// Under `-y` strace names a directory descriptor by its path
// (`4</ws/q"d>`), and a directory's name may hold a quote. The parse read
// that path only up to its first quote: a read through it went unjudged
// and a denial through it named the wrong path (2026-10-02).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { deniedCalls } from '../src/exec/sandbox-violations.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

describe('deniedCalls › a directory descriptor whose path holds a quote', () => {
  it('places a read by the path it opened, and a denial by its own name', () => {
    const trace = [
      '10 openat(4</ws/q"d>, "f", O_RDONLY|O_NOFOLLOW) = 3</ws/q"d/f>',
      '10 openat(4</ws/q"d>, "g", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '10 openat(4</ws/q"d>, "h", O_RDONLY <unfinished ...>',
      '10 <... openat resumed>) = 5</ws/q"d/h>',
      '',
    ].join('\n')
    expect(deniedCalls(trace, '/ws', true).map((c) => [c.rawPath, c.errno])).toEqual([
      ['/ws/q"d/f', ''],
      ['g', 'ENOENT'],
      ['/ws/q"d/h', ''],
    ])
  })
})

describe('deniedCalls › a denial through a directory descriptor', () => {
  it('is placed in the directory -y names, whole or split', () => {
    const trace = [
      '10 openat(4</ws/p/sub>, "g", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '10 openat(4</ws/p/q"d>, "h", O_RDONLY <unfinished ...>',
      '10 <... openat resumed>) = -1 ENOENT (No such file or directory)',
      '10 openat(AT_FDCWD</ws/p/src>, "i", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(trace, '/ws/p').map((c) => [c.rawPath, c.dir])).toEqual([
      ['g', '/ws/p/sub'],
      ['h', '/ws/p/q"d'],
      ['i', '/ws/p/src'],
    ])
  })

  it('CONTROL: an absolute path, or a descriptor with no -y path, keeps the cwd', () => {
    const trace = [
      '10 openat(4</ws/p/sub>, "/ws/p/abs", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '10 openat(4, "g", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(trace, '/ws/p').map((c) => [c.rawPath, c.dir])).toEqual([
      ['/ws/p/abs', undefined],
      ['g', undefined],
    ])
  })
})

const available = await sandboxAvailable('sandbox dirfd-quote test')

describe.skipIf(!available || process.platform !== 'linux')(
  'a read under a widened grant, through a quoted directory',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-dirfd-')))
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    it('is reported by its path', async () => {
      const proj = path.join(dir, 'proj')
      for (const d of ['q"d', 'plain']) {
        await mkdir(path.join(proj, d), { recursive: true })
        await writeFile(path.join(proj, d, 'f'), 'x')
      }
      const r = await runSandboxed({
        command: 'echo > out.txt; grep -r -l . . > /dev/null; true',
        cwd: proj,
        env: process.env,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { write: ['out.txt'] } }, proj),
      })
      expect(r.violations.map((v) => String(v.target)).sort((a, b) => a.localeCompare(b))).toEqual(
        [proj, ...['plain', 'plain/f', 'q"d', 'q"d/f'].map((f) => path.join(proj, f))].sort(
          (a, b) => a.localeCompare(b),
        ),
      )
    })
  },
)
