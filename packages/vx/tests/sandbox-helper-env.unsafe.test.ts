// The sandbox runtime's host bridge (`socat UNIX-LISTEN:… TCP:localhost:…`)
// lives for the whole run beside the tasks. Spawned with no env, it held
// vx's: an unsandboxed task read every secret vx holds from its
// `/proc/<pid>/environ`, the hole `hideEnvFromTasks` closes for vx itself.
// Unsafe: it brings the sandbox up, which cannot nest in a sandboxed shard.
import { readdirSync, readFileSync } from 'node:fs'
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
})
