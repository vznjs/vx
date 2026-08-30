// The pool's contract, exercised with a fake agent so none of this needs a
// container. What matters here is leasing: an agent handed to two tasks at
// once would let them corrupt each other's working tree, and an agent that is
// never returned strands a slot until the run ends.

import { describe, expect, it } from 'bun:test'
import { AgentPool, type Agent, type AgentCommand } from '../src/pool.js'
import { agentEnv, acceptsTask, fullCommand, relativeCwd } from '../src/index.js'
import { joinPosix } from '../src/docker.js'
import type { ExecuteRequest, TaskPlacement } from '@vzn/vx'

interface FakeAgent extends Agent {
  readonly ran: string[]
  live: number
  peak: number
}

function fakeAgent(id: string, opts: { prepareExit?: number } = {}): FakeAgent {
  const a: FakeAgent = {
    id,
    ran: [],
    live: 0,
    peak: 0,
    async exec(spec: AgentCommand) {
      a.ran.push(spec.command)
      a.live++
      a.peak = Math.max(a.peak, a.live)
      await Bun.sleep(1)
      a.live--
      if (opts.prepareExit !== undefined && spec.command === 'prepare') {
        spec.onStderr('install blew up\n')
        return { exitCode: opts.prepareExit }
      }
      return { exitCode: 0 }
    },
    async dispose() {
      /* nothing to release */
    },
  }
  return a
}

describe('AgentPool leasing', () => {
  it('creates at most `size` agents, however many tasks arrive', async () => {
    const made: FakeAgent[] = []
    const pool = new AgentPool({
      size: 2,
      create: async (i) => {
        const a = fakeAgent(`a${i}`)
        made.push(a)
        return a
      },
    })
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        const lease = await pool.acquire()
        try {
          await lease.agent.exec({
            command: 'work',
            cwd: '.',
            env: {},
            onStdout: () => undefined,
            onStderr: () => undefined,
          })
        } finally {
          lease.release()
        }
      }),
    )
    expect(made.length).toBe(2)
    // …and never handed the same agent to two tasks at once, which is the
    // property that keeps two commands out of one working tree.
    for (const a of made) expect(a.peak).toBe(1)
    await pool.close()
  })

  it('a concurrent burst cannot over-create past the reserved slots', async () => {
    // The slot is taken BEFORE the (async) create resolves. Without that,
    // every acquire in the burst sees room and the pool overshoots.
    let creating = 0
    let peakCreating = 0
    const pool = new AgentPool({
      size: 3,
      create: async (i) => {
        creating++
        peakCreating = Math.max(peakCreating, creating)
        await Bun.sleep(5)
        creating--
        return fakeAgent(`a${i}`)
      },
    })
    // Exactly `size` at once: asking for more than the pool holds without
    // releasing is a deadlock by construction, not a property worth pinning.
    const leases = await Promise.all(Array.from({ length: 3 }, () => pool.acquire()))
    expect(peakCreating).toBeLessThanOrEqual(3)
    expect(new Set(leases.map((l) => l.agent.id)).size).toBe(3)
    leases.forEach((l) => l.release())
    // And a fourth waiter is served by a released agent rather than a new one.
    const fourth = await pool.acquire()
    expect(['a0', 'a1', 'a2']).toContain(fourth.agent.id)
    fourth.release()
    await pool.close()
  })

  it('runs `prepare` exactly once per agent, before any task', async () => {
    const made: FakeAgent[] = []
    const pool = new AgentPool({
      size: 2,
      prepare: 'prepare',
      create: async (i) => {
        const a = fakeAgent(`a${i}`)
        made.push(a)
        return a
      },
    })
    for (let i = 0; i < 6; i++) {
      const lease = await pool.acquire()
      await lease.agent.exec({
        command: 'work',
        cwd: '.',
        env: {},
        onStdout: () => undefined,
        onStderr: () => undefined,
      })
      lease.release()
    }
    for (const a of made) {
      expect(a.ran.filter((c) => c === 'prepare').length).toBe(1)
      expect(a.ran[0]).toBe('prepare')
    }
    await pool.close()
  })

  it('a failing `prepare` is FATAL, and says what the install printed', async () => {
    // An agent that silently skipped its install would run every task against
    // a half-built tree and report the failures as the tasks' own.
    const pool = new AgentPool({
      size: 1,
      prepare: 'prepare',
      create: async (i) => fakeAgent(`a${i}`, { prepareExit: 1 }),
    })
    await expect(pool.acquire()).rejects.toThrow(/failed to prepare.*install blew up/s)
    await pool.close()
  })

  it('release is idempotent — a double release cannot clone a slot', async () => {
    const pool = new AgentPool({ size: 1, create: async (i) => fakeAgent(`a${i}`) })
    const lease = await pool.acquire()
    lease.release()
    lease.release()
    const again = await pool.acquire()
    expect(again.agent.id).toBe(lease.agent.id)
    again.release()
    await pool.close()
  })

  it('rejects a size that cannot hold an agent', () => {
    expect(() => new AgentPool({ size: 0, create: async () => fakeAgent('x') })).toThrow(
      /positive integer/,
    )
  })

  it('close() disposes every agent and survives a disposer that throws', async () => {
    const disposed: string[] = []
    const pool = new AgentPool({
      size: 2,
      create: async (i) => ({
        id: `a${i}`,
        exec: async () => ({ exitCode: 0 }),
        dispose: async () => {
          disposed.push(`a${i}`)
          if (i === 0) throw new Error('container already gone')
        },
      }),
    })
    const first = await pool.acquire()
    const second = await pool.acquire()
    first.release()
    second.release()
    // Teardown must not turn a green run red.
    await pool.close()
    expect(disposed.sort()).toEqual(['a0', 'a1'])
  })
})

describe('what crosses to an agent', () => {
  const req = (over: Partial<ExecuteRequest>): ExecuteRequest =>
    ({
      command: 'build',
      forwardArgs: [],
      envDefine: {},
      inputs: { env: [] },
      ...over,
    }) as unknown as ExecuteRequest

  it('carries declared env: inputs.env values and exec.env.define literals', () => {
    expect(
      agentEnv(
        req({
          inputs: { env: [{ name: 'API', value: 'https://x' }] },
          envDefine: { NODE_ENV: 'production' },
        } as unknown as Partial<ExecuteRequest>),
      ),
    ).toEqual({ API: 'https://x', NODE_ENV: 'production' })
  })

  it('a define wins a collision — it is the more explicit statement', () => {
    expect(
      agentEnv(
        req({
          inputs: { env: [{ name: 'MODE', value: 'ambient' }] },
          envDefine: { MODE: 'declared' },
        } as unknown as Partial<ExecuteRequest>),
      ),
    ).toEqual({ MODE: 'declared' })
  })

  // CONTROL: the resolved child environment is this machine's — its PATH, its
  // HOME, its TMPDIR — and an agent has its own. Nothing is invented either.
  it('never ships the resolved child environment', () => {
    const r = req({ env: { PATH: '/opt/homebrew/bin', HOME: '/Users/someone' } } as never)
    expect(agentEnv(r)).toEqual({})
  })

  it('appends forwarded args shell-quoted, as the local executor does', () => {
    expect(fullCommand(req({ command: 'bun test', forwardArgs: ['-t', "it's fine"] }))).toBe(
      `bun test '-t' 'it'\\''s fine'`,
    )
  })
})

describe('paths inside the agent', () => {
  it('makes the task cwd workspace-relative', () => {
    expect(relativeCwd('/w', '/w/packages/vx')).toBe('packages/vx')
    expect(relativeCwd('/w', '/w')).toBe('.')
  })

  it('joins against the container mount, POSIX regardless of this host', () => {
    expect(joinPosix('/workspace', 'packages/vx')).toBe('/workspace/packages/vx')
    expect(joinPosix('/workspace/', './packages/vx')).toBe('/workspace/packages/vx')
    expect(joinPosix('/workspace', '.')).toBe('/workspace')
  })
})

describe('placement', () => {
  const placement = (over: Partial<TaskPlacement>): TaskPlacement =>
    ({ taskId: 'a#b', pinnedLocal: false, cacheable: true, ...over }) as TaskPlacement

  it('declines a task pinned local — a persistent task owns a port here', () => {
    expect(acceptsTask(placement({ pinnedLocal: true }))).toBe(false)
  })

  // Unlike a remote ACTION, an agent needs no input tree, so a task without a
  // cache block is still perfectly runnable there.
  it('accepts a non-cacheable task, which a REAPI executor cannot', () => {
    expect(acceptsTask(placement({ cacheable: false }))).toBe(true)
  })
})
