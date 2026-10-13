// vx holds variables it never passes a task (a token, a key). On Linux an
// unsandboxed task, running as the same user, could read them from vx's
// `/proc/<pid>/environ`; with a secret in its env vx makes itself
// non-dumpable, which closes that file to the task. Unsafe: a sandboxed
// shard's user namespace answers the permission check its own way, and
// root bypasses it (VX_REQUIRE_NONROOT makes root a failure on CI).
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { hideEnvFromTasks } from '../src/util/hide-env.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

const HIDE = path.resolve(import.meta.dir, '..', 'src', 'util', 'hide-env.ts')
const linux = process.platform === 'linux'

/** What a child of a process that ran `hide` (or not) reads of its env. */
function probe(hide: boolean, secret: string): { hidden: string; child: string } {
  const script = `
const { hideEnvFromTasks } = await import(${JSON.stringify(HIDE)})
const hidden = ${hide} ? await hideEnvFromTasks() : 'skipped'
const r = Bun.spawnSync(['sh', '-c', 'grep -qaF -e "$1" /proc/$PPID/environ 2>/dev/null && echo LEAK || echo CLEAN', 'sh', process.env.VX_TEST_SECRET.slice(0, 12)], { env: { PATH: process.env.PATH } })
console.log(JSON.stringify({ hidden: String(hidden), child: r.stdout.toString().trim() }))
`
  const r = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    env: { PATH: process.env['PATH'], VX_TEST_SECRET: secret },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  return JSON.parse(r.stdout.toString()) as { hidden: string; child: string }
}

describe.skipIf(!linux || skipAsRoot('hide-env'))("vx's env and a same-user child", () => {
  it('a child reads it while vx is dumpable, and not once a secret makes vx hide it', () => {
    const secret = `s${crypto.randomUUID()}`
    expect({ control: probe(false, secret), hidden: probe(true, secret) }).toEqual({
      control: { hidden: 'skipped', child: 'LEAK' },
      hidden: { hidden: 'true', child: 'CLEAN' },
    })
  })
})

describe('with no secret in the env', () => {
  it('loads no FFI and changes nothing', async () => {
    let loads = 0
    const hidden = await hideEnvFromTasks({ PATH: '/usr/bin', HOME: '/home/x' }, () => {
      loads++
      return import('bun:ffi')
    })
    expect({ hidden, loads }).toEqual({ hidden: false, loads: 0 })
  })
})
