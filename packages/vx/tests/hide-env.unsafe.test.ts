// vx holds variables it never passes a task (a token, a key). On Linux an
// unsandboxed task, running as the same user, could read them from vx's
// `/proc/<pid>/environ`; vx makes itself non-dumpable on every verb, which
// closes that file to the task. Unsafe: a sandboxed shard's user namespace
// answers the permission check its own way, and root bypasses it
// (VX_REQUIRE_NONROOT makes root a failure on CI).
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { skipAsRoot } from './helpers/nonroot-gate.js'

const HIDE = path.resolve(import.meta.dir, '..', 'src', 'util', 'hide-env.ts')

/** What a child of a process that ran `hide` (or not) reads of its env. */
function probe(hide: boolean, canary: string): { hidden: string; child: string } {
  const script = `
const { hideEnvFromTasks } = await import(${JSON.stringify(HIDE)})
const hidden = ${hide} ? await hideEnvFromTasks() : 'skipped'
const r = Bun.spawnSync(['sh', '-c', 'grep -qaF -e "$1" /proc/$PPID/environ 2>/dev/null && echo LEAK || echo CLEAN', 'sh', process.env.VX_TEST_CANARY.slice(0, 12)], { env: { PATH: process.env.PATH } })
console.log(JSON.stringify({ hidden: String(hidden), child: r.stdout.toString().trim() }))
`
  const r = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    // No secret-named variable: the hiding holds for any value.
    env: { PATH: process.env['PATH'], VX_TEST_CANARY: canary },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  return JSON.parse(r.stdout.toString()) as { hidden: string; child: string }
}

describe.skipIf(process.platform !== 'linux' || skipAsRoot('hide-env'))(
  "vx's env and a same-user child",
  () => {
    it('a child reads it while vx is dumpable, and not once vx hides it', () => {
      const canary = `c${crypto.randomUUID()}`
      expect({ control: probe(false, canary), hidden: probe(true, canary) }).toEqual({
        control: { hidden: 'skipped', child: 'LEAK' },
        hidden: { hidden: 'true', child: 'CLEAN' },
      })
    })
  },
)
