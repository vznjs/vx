// Without `-y` (no widened grant) strace names a directory descriptor by
// its number alone, and a denial through it was placed in the cwd:
// Python's `os.open('nope.txt', dir_fd=d)` inside its `src/` grant failed
// the task as a refused `nope.txt`, and the real denial of
// `src/../other/o.txt` was reported at the wrong path (2026-11-06).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox, resolveSandboxConfig, runSandboxed } from '../src/exec/index.js'
import { deniedCalls } from '../src/exec/sandbox-violations.js'
import { envFlag } from './helpers/env.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

describe('deniedCalls › a denial through a descriptor strace names by number', () => {
  it('is placed where the traced open of that descriptor pointed', () => {
    const trace = [
      '10 chdir("pkg") = 0',
      '10 openat(AT_FDCWD, "src", O_RDONLY|O_CLOEXEC) = 3',
      '10 openat(3, "nope.txt", O_RDONLY|O_CLOEXEC) = -1 ENOENT (No such file or directory)',
      '10 openat(3, "sub", O_RDONLY <unfinished ...>',
      '10 <... openat resumed>) = 4',
      '10 clone(child_stack=NULL, flags=SIGCHLD) = 11',
      '11 openat(4, "g", O_RDONLY) = -1 EACCES (Permission denied)',
      '10 openat(AT_FDCWD, "/ws/abs", O_RDONLY) = 3',
      '10 openat(3, "h", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '',
    ].join('\n')
    expect(deniedCalls(trace, '/ws').map((c) => [c.rawPath, c.dir])).toEqual([
      ['nope.txt', '/ws/pkg/src'],
      ['g', '/ws/pkg/src/sub'],
      ['h', '/ws/abs'],
    ])
  })
})

const available = await sandboxAvailable('sandbox dirfd-open test')
const python = Bun.which('python3')
if (available && python === null && envFlag('VX_REQUIRE_SANDBOX')) {
  throw new Error('sandbox dirfd-open test: python3 is not on PATH')
}

describe.skipIf(!available || python === null || process.platform !== 'linux')(
  'an open through a directory descriptor, no grant widened',
  () => {
    let dir = ''
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-dirfd-open-')))
      await initSandbox()
    })
    afterEach(async () => {
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    it('reports the real denial at its path, and not a miss inside the grant', async () => {
      const proj = path.join(dir, 'proj')
      await mkdir(path.join(proj, 'src'), { recursive: true })
      await mkdir(path.join(proj, 'other'), { recursive: true })
      await writeFile(path.join(proj, 'other', 'o.txt'), 'x')
      const script = [
        'import os',
        "d = os.open('src', os.O_RDONLY)",
        "for p in ('nope.txt', '../other/o.txt'):",
        '    try: os.open(p, os.O_RDONLY, dir_fd=d)',
        '    except OSError: pass',
      ].join('\n')
      const r = await runSandboxed({
        command: `${python} -c "${script}"`,
        cwd: proj,
        env: process.env,
        baseAllowRead: [],
        baseDenyRead: [dir],
        reportWithin: proj,
        reportLinked: [],
        config: resolveSandboxConfig({ allow: { read: ['src/'] } }, proj),
      })
      expect([r.exitCode, r.violations.map((v) => v.target)]).toEqual([
        0,
        [path.join(proj, 'other', 'o.txt')],
      ])
    })
  },
)
