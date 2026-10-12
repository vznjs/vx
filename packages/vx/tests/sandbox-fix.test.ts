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
      read: ['/etc/hosts', 'src/i.js', 'tsconfig.json', '~/.npmrc'],
      write: ['dist/', 'log.txt', 'out/'],
      network: ['example.com'],
      systemInfo: ['kern.x'],
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
