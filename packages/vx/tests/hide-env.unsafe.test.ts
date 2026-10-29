// vx holds variables it never passes a task (a token, a key). An
// unsandboxed task runs as the same user: on Linux it could read them from
// vx's `/proc/<pid>/environ`, on macOS through `ps eww`. vx hides them on
// every verb: non-dumpable on Linux, the startup values zeroed on macOS.
// Unsafe: a sandboxed shard's user namespace answers the permission check
// its own way, and root bypasses it (VX_REQUIRE_NONROOT makes root a
// failure on CI).
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { skipAsRoot } from './helpers/nonroot-gate.js'

const HIDE = path.resolve(import.meta.dir, '..', 'src', 'util', 'hide-env.ts')

// What a same-user child sees of its parent's startup env, per platform.
const READ_PARENT =
  process.platform === 'darwin'
    ? 'ps eww -o command= -p $PPID | grep -qF -e "$1" && echo LEAK || echo CLEAN'
    : 'grep -qaF -e "$1" /proc/$PPID/environ 2>/dev/null && echo LEAK || echo CLEAN'

interface Probe {
  ms?: number
  hidden: string
  child: string
  env: string | undefined
  path: boolean
  task: string
}

/** What a child of a process that ran `hide` (or not) reads of its env. */
function probe(hide: boolean, canary: string): Probe {
  const script = `
const { hideEnvFromTasks } = await import(${JSON.stringify(HIDE)})
const t = performance.now()
const hidden = ${hide} ? await hideEnvFromTasks() : 'skipped'
const ms = performance.now() - t
const r = Bun.spawnSync(['sh', '-c', ${JSON.stringify(READ_PARENT)}, 'sh', process.env.VX_TEST_CANARY.slice(0, 12)], { env: { PATH: process.env.PATH } })
const task = Bun.spawnSync(['sh', '-c', 'printf %s "$VX_TEST_CANARY"'], { env: { PATH: process.env.PATH, VX_TEST_CANARY: process.env.VX_TEST_CANARY } })
console.log(JSON.stringify({ ms, hidden: String(hidden), child: r.stdout.toString().trim(), env: process.env.VX_TEST_CANARY, path: r.exitCode === 0, task: task.stdout.toString() }))
`
  const r = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    // No secret-named variable: the hiding holds for any value.
    env: { PATH: process.env['PATH'], VX_TEST_CANARY: canary },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  return JSON.parse(r.stdout.toString()) as Probe
}

function withoutMs(p: Probe): Probe {
  const { ms, ...rest } = p
  void ms
  return rest
}

describe.skipIf(
  (process.platform !== 'linux' && process.platform !== 'darwin') || skipAsRoot('hide-env'),
)("vx's env and a same-user child", () => {
  it('a child reads it while vx shows it, and not once vx hides it; vx and its tasks keep it', () => {
    const canary = `c${crypto.randomUUID()}`
    const kept = { env: canary, path: true, task: canary }
    expect({
      control: withoutMs(probe(false, canary)),
      hidden: withoutMs(probe(true, canary)),
    }).toEqual({
      control: { hidden: 'skipped', child: 'LEAK', ...kept },
      hidden: { hidden: 'true', child: 'CLEAN', ...kept },
    })
  })

  // What hiding costs a command, printed for the record (owner,
  // 2026-10-13): min of 10 fresh processes, `bun:ffi` load included.
  it('prints what it costs', () => {
    const canary = `c${crypto.randomUUID()}`
    const ms = Math.min(...Array.from({ length: 10 }, () => probe(true, canary).ms!))
    console.info(`hide-env ${process.platform}: ${ms.toFixed(2)} ms`)
    expect(ms).toBeLessThan(50)
  })
})

// `debug.dumpable` is a bool setting: `0` and `false` are off, as for every
// other bool, and only a true value keeps vx dumpable. Root may still call
// prctl, so this needs no non-root gate.
describe.skipIf(process.platform !== 'linux')('VX_DEBUG_DUMPABLE', () => {
  function hides(value: string | undefined): string {
    const r = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `const { hideEnvFromTasks } = await import(${JSON.stringify(HIDE)}); console.log(String(await hideEnvFromTasks()))`,
      ],
      env: {
        PATH: process.env['PATH'],
        ...(value === undefined ? {} : { VX_DEBUG_DUMPABLE: value }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    return r.stdout.toString().trim()
  }

  it('hides unless the setting is true', () => {
    expect({
      unset: hides(undefined),
      empty: hides(''),
      zero: hides('0'),
      false: hides('false'),
      one: hides('1'),
      true: hides('true'),
    }).toEqual({
      unset: 'true',
      empty: 'true',
      zero: 'true',
      false: 'true',
      one: 'false',
      true: 'false',
    })
  })
})
