import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SandboxViolation } from '../src/exec/index.js'
import { sandboxFix } from '../src/orchestrator/sandbox-fix.js'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-fix-')))
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src', 'i.js'), '')
  writeFileSync(path.join(dir, 'tsconfig.json'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const v = (
  line: string,
  ignorable: SandboxViolation['ignorable'],
  target: string,
  extra: Partial<SandboxViolation> = {},
): SandboxViolation => ({
  line,
  timestamp: new Date(),
  target,
  ...(target.startsWith('/') ? { path: target } : {}),
  ...(ignorable !== undefined ? { ignorable } : {}),
  ...extra,
})

describe('sandboxFix', () => {
  it('turns each denial into the grant that allows it', () => {
    const at = (p: string) => path.join(dir, p)
    const fix = sandboxFix(
      [
        // Linux openat: the host has the file, so it was a hidden read.
        v('openat(src/i.js) = -1 ENOENT', ['read', 'write'], at('src/i.js')),
        v('openat(tsconfig.json) = -1 ENOENT', ['read', 'write'], at('tsconfig.json')),
        // The host lacks it: a create, granted as its top directory.
        v('openat(dist/a/o.js) = -1 ENOENT', ['read', 'write'], at('dist/a/o.js')),
        v('mkdir(out) = -1 EROFS', ['write'], at('out')),
        v('deny(1) file-write-create', ['write'], at('log.txt')),
        v('deny network-outbound example.com:443 (x)', ['network'], 'example.com:443'),
        v('deny(1) sysctl-read kern.x', ['systemInfo'], 'kern.x'),
        v('deny(1) file-read-data', ['read'], path.join(os.homedir(), '.npmrc')),
        v('deny(1) file-read-data', ['read'], '/etc/hosts'),
        // vx's own note is no denial.
        v('cwd unreadable', ['read'], at('src/i.js'), { hint: true }),
        v('deny(1) mach-lookup x', undefined, 'x'),
      ],
      dir,
    )
    expect(fix).toEqual({
      read: ['/etc/hosts', 'src/i.js', 'tsconfig.json'],
      write: ['dist/', 'log.txt', 'out/'],
      network: ['example.com'],
      systemInfo: ['kern.x'],
      withheld: ['~/.npmrc'],
    })
  })

  it('grants a write under a read input as the file alone', () => {
    const write = (p: string) => v('deny(1) file-write-create', ['write'], path.join(dir, p))
    const denials = [write('src/gen.js'), write('dist/a.js'), write('lib/x.js')]
    expect(sandboxFix(denials, dir, undefined, ['src/**', '!dist/**'])?.write).toEqual([
      'dist/',
      'lib/',
      'src/gen.js',
    ])
    expect(sandboxFix(denials, dir, undefined, ['./**/*.ts'])?.write).toEqual([
      'dist/a.js',
      'lib/x.js',
      'src/gen.js',
    ])
  })

  it('never turns a credential path into a grant', () => {
    const home = (p: string) => path.join(os.homedir(), p)
    const read = (p: string) => v('deny(1) file-read-data', ['read'], p)
    const fix = sandboxFix(
      [
        read(home('.ssh/id_ed25519')),
        read(home('.ssh')),
        read(home('.aws/credentials')),
        read(home('.gnupg/pubring.kbx')),
        read(home('.kube/config')),
        read(home('.config/gh/hosts.yml')),
        read(home('.docker/config.json')),
        read(home('.netrc')),
        read(home('.git-credentials')),
        read(home('.pypirc')),
        read(home('.config/gcloud/credentials.db')),
        read(path.join(dir, '.env')),
        v('deny(1) file-write-create', ['write'], path.join(dir, '.env.local')),
        // Near misses stay grants.
        read(home('.sshrc')),
        read(home('.config/ghx')),
        read(path.join(dir, '.envrc')),
        read(path.join(dir, 'env')),
      ],
      dir,
    )
    expect(fix).toEqual({
      read: ['.envrc', 'env', '~/.config/ghx', '~/.sshrc'],
      withheld: [
        '.env',
        '.env.local',
        '~/.aws/credentials',
        '~/.config/gcloud/credentials.db',
        '~/.config/gh/hosts.yml',
        '~/.docker/config.json',
        '~/.git-credentials',
        '~/.gnupg/pubring.kbx',
        '~/.kube/config',
        '~/.netrc',
        '~/.pypirc',
        '~/.ssh',
        '~/.ssh/id_ed25519',
      ],
    })
  })

  it('is undefined when nothing maps, and masks what it names', () => {
    expect(sandboxFix([v('x', undefined, 'x')], dir)).toBeUndefined()
    const fix = sandboxFix(
      [v('deny(1) file-read-data', ['read'], path.join(dir, 'tok-SECRET'))],
      dir,
      (t) => t.replaceAll('SECRET', '***'),
    )
    expect(fix).toEqual({ read: ['tok-***'] })
  })
})
