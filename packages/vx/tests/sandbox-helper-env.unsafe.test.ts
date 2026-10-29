// The sandbox runtime's host bridge (`socat UNIX-LISTEN:… TCP:localhost:…`)
// lives for the whole run beside the tasks. Spawned with no env, it held
// vx's: an unsandboxed task read every secret vx holds from its
// `/proc/<pid>/environ`, the hole `hideEnvFromTasks` closes for vx itself.
// Unsafe: it brings the sandbox up, which cannot nest in a sandboxed shard.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { initSandbox, resetSandbox } from '../src/exec/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const linux = process.platform === 'linux'
const available = linux && (await sandboxAvailable('sandbox-helper-env'))

/** The env of every live socat this process started, by pid. */
function socatEnvs(): Map<number, string> {
  const out = new Map<number, string>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8')
      if (ppid !== process.pid || !cmd.includes('UNIX-LISTEN:')) continue
      out.set(Number(name), readFileSync(`/proc/${name}/environ`, 'utf8'))
    } catch {
      // gone, or not ours to read
    }
  }
  return out
}

describe.skipIf(!available)('the sandbox runtime’s host bridge', () => {
  afterAll(() => resetSandbox())

  it('holds none of vx’s env a task is not given', async () => {
    const canary = `c${crypto.randomUUID()}`
    process.env['VX_TEST_BRIDGE_CANARY'] = canary
    try {
      await resetSandbox()
      await initSandbox()
      const envs = socatEnvs()
      expect(envs.size).toBeGreaterThan(0)
      for (const env of envs.values()) {
        expect(env.includes(canary)).toBe(false)
        // It still finds its tools.
        expect(env.split('\0').some((v) => v.startsWith('PATH='))).toBe(true)
      }
    } finally {
      delete process.env['VX_TEST_BRIDGE_CANARY']
    }
  })
  // The wrapper's path is memoized per process; SRT's exit cleanup lets an
  // init follow in the same process, and a wrapper removed meanwhile was
  // handed to SRT anyway: "socat not executable". A child process of its
  // own, with its own TMPDIR, so the memo starts empty and removing the
  // wrapper reaches no other process's.
  it('is made again for an init after its wrapper was removed', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'vx-socat-remake-'))
    try {
      const src = path.join(import.meta.dir, '../src/exec/index.js')
      const script = `
        import { rmSync } from 'node:fs'
        import os from 'node:os'
        import path from 'node:path'
        const { initSandbox, probeSandbox, resetSandbox } = await import(${JSON.stringify(src)})
        await initSandbox()
        await resetSandbox()
        rmSync(path.join(os.tmpdir(), 'vx-socat-' + process.getuid()), { recursive: true, force: true })
        let initError = ''
        try { await initSandbox() } catch (err) { initError = String(err) }
        const probe = await probeSandbox()
        await resetSandbox()
        console.log(JSON.stringify({ initError, probe }))
      `
      const r = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, TMPDIR: tmp },
        stderr: 'pipe',
      })
      expect(r.stderr.toString()).toBe('')
      expect(JSON.parse(r.stdout.toString())).toEqual({
        initError: '',
        probe: { available: true, reason: '' },
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
