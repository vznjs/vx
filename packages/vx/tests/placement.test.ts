// `pinnedLocalSet` is the one rule that keeps a task off every remote
// executor. Two site pages and the local-floor post said a sandboxed task
// runs here because the sandbox is this machine's machinery; the set had no
// such rule until 2026-09-16 (item 335), so a sandboxed cacheable task was
// offered to a remote executor that enforces no sandbox and reports no
// violations.
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  UNPLACED_EXECUTOR,
  hasPooledExecutor,
  locallyPlaced,
  pinnedLocalSet,
  placeTasks,
  poolOfPlacement,
} from '../src/orchestrator/placement.js'
import type { Placements } from '../src/orchestrator/placement.js'
import type { TaskExecutor, TaskPlacement } from '../src/exec/executor.js'
import { localExecutor } from '../src/exec/local-executor.js'
import type { TaskNode } from '../src/graph/task-graph.js'

function node(id: string, exec: Record<string, unknown>, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    taskName: id.split('#')[1]!,
    projectDir: '/w/' + id.split('#')[0]!,
    deps,
    config: { exec: { command: 'true', ...exec } },
  } as unknown as TaskNode
}

const graph = (...nodes: TaskNode[]): Map<string, TaskNode> => new Map(nodes.map((n) => [n.id, n]))

describe('pinnedLocalSet', () => {
  it('a plain task is not pinned (control)', () => {
    expect(pinnedLocalSet(graph(node('a#build', {})))).toEqual(new Set())
  })

  it('a persistent task, and everything depending on it, is pinned', () => {
    const set = pinnedLocalSet(
      graph(
        node('a#dev', { persistent: {} }),
        node('b#e2e', {}, ['a#dev']),
        node('c#test', {}, ['b#e2e']),
        node('d#build', {}),
      ),
    )
    expect([...set].sort()).toEqual(['a#dev', 'b#e2e', 'c#test'])
  })

  // C-2: a runtime probe (`node -v`) is answered by THIS machine and folded
  // into the key; a remote worker running another Node saved its output
  // under this machine's key, a stale hit for every later run here.
  it('a task whose key folds a runtime probe is pinned; its dependants are not', () => {
    const probed = (id: string, inputs: Record<string, unknown>, deps: string[] = []): TaskNode => {
      const n = node(id, {}, deps)
      return {
        ...n,
        config: {
          ...n.config,
          inputs: { files: ['src/**'], ...inputs },
          cache: { outputs: { files: [] } },
        },
      } as TaskNode
    }
    const set = pinnedLocalSet(
      graph(
        probed('a#build', { runtime: ['node -v'] }),
        probed('b#build', { workspaceRuntime: ['node -v'] }),
        probed('c#build', {}, ['a#build']),
        probed('d#build', { runtime: [] }),
      ),
    )
    expect([...set].sort()).toEqual(['a#build', 'b#build'])
  })

  it('exec.remote: false pins the task and its dependants', () => {
    const set = pinnedLocalSet(
      graph(node('a#build', { remote: false }), node('b#test', {}, ['a#build'])),
    )
    expect([...set].sort()).toEqual(['a#build', 'b#test'])
  })

  it("a sandboxed task is pinned: the sandbox is this machine's machinery", () => {
    const set = pinnedLocalSet(graph(node('a#build', { sandbox: { allow: { read: [] } } })))
    expect([...set]).toEqual(['a#build'])
  })

  it('a dependant of a sandboxed task is pinned with it', () => {
    const set = pinnedLocalSet(
      graph(node('a#build', { sandbox: {} }), node('b#test', {}, ['a#build']), node('c#lint', {})),
    )
    expect([...set].sort()).toEqual(['a#build', 'b#test'])
  })

  it('every dependant of a pinned task is pinned, not only the first', () => {
    const set = pinnedLocalSet(
      graph(
        node('a#dev', { persistent: {} }),
        node('b#e2e', {}, ['a#dev']),
        node('c#e2e', {}, ['a#dev']),
      ),
    )
    expect([...set].sort()).toEqual(['a#dev', 'b#e2e', 'c#e2e'])
  })

  // Each task is walked once: a ladder of 40 diamonds has 2^40 paths from
  // its top to the pinned bottom, and a walk that re-entered a pinned task
  // followed every one of them. The walk is synchronous, so it runs in a
  // child a deadline can kill; the pristine walk takes milliseconds.
  it('a ladder of 40 diamonds pinned at its bottom is walked once per task', async () => {
    const code = `
      import { pinnedLocalSet } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/orchestrator/placement.ts'))}
      const node = (id, exec, deps) => [id, { id, deps, config: { exec: { command: 'true', ...exec } } }]
      const nodes = [node('app#base', { persistent: {} }, [])]
      let below = ['app#base']
      for (let i = 0; i < 40; i++) {
        const level = ['app#l' + i + 'a', 'app#l' + i + 'b']
        for (const id of level) nodes.push(node(id, {}, below))
        below = level
      }
      console.log(pinnedLocalSet(new Map(nodes)).size)
    `
    const child = Bun.spawn([process.execPath, '-e', code], {
      env: { ...process.env },
      stdout: 'pipe',
      timeout: 4_000,
    })
    expect([await child.exited, (await new Response(child.stdout).text()).trim()]).toEqual([
      0,
      '81',
    ])
  })

  // `vx run app#t0 --dry` on this chain threw `RangeError` here once the
  // builder (item 737) and the excluded-key walk (741) stopped recursing:
  // the set recursed once per edge.
  it('a 50,000-deep chain pinned at its bottom pins every task above it', () => {
    const DEPTH = 50_000
    const nodes: TaskNode[] = []
    for (let i = 0; i < DEPTH; i++) {
      nodes.push(
        i + 1 < DEPTH
          ? node(`app#t${i}`, {}, [`app#t${i + 1}`])
          : node(`app#t${i}`, { persistent: {} }),
      )
    }
    nodes.push(node('app#aside', {}, ['app#t0']), node('app#other', {}))
    const set = pinnedLocalSet(graph(...nodes))
    expect([set.size, set.has('app#aside'), set.has('app#other')]).toEqual([DEPTH + 1, true, false])
  })
})

describe('placeTasks (item 650)', () => {
  // Two gates in the placement loop survived the whole core suite: the
  // persistent skip (the executor entry it withholds is one nothing
  // reads at run time) and the `cacheable` hint (only a plugin reads it,
  // and core has no plugin). Each is a plugin-facing fact, so each gets
  // its row here.
  const seen = (): { executor: TaskExecutor; asks: Array<[string, boolean]> } => {
    const asks: Array<[string, boolean]> = []
    return {
      asks,
      executor: {
        name: 'recorder',
        accepts: (t) => {
          asks.push([t.taskId, t.cacheable])
          return true
        },
        execute: () => {
          throw new Error('never runs')
        },
      },
    }
  }

  it('a persistent task is never placed: no executor entry, no ask', () => {
    const { executor, asks } = seen()
    const placements = placeTasks(
      graph(node('a#dev', { persistent: {} }), node('b#build', {}, ['a#dev'])),
      [executor],
    )
    expect([[...placements.executors.keys()], asks.map(([id]) => id)]).toEqual([
      ['b#build'],
      ['b#build'],
    ])
  })

  it('an executor is told whether the task it is offered is cacheable', () => {
    const { executor, asks } = seen()
    const cached = node('a#build', {})
    ;(cached.config as { cache?: unknown }).cache = { inputs: { files: ['src/**'] } }
    placeTasks(graph(cached, node('b#lint', {})), [executor])
    expect(asks.sort((x, y) => x[0].localeCompare(y[0]))).toEqual([
      ['a#build', true],
      ['b#lint', false],
    ])
  })
})

// Nothing runs on a distributed run's orchestrator (2026-10-22): a
// `servers` executor takes a server's dependants and starts the server
// where each runs, so the server is never spawned here.
describe('placeTasks — a servers executor carries persistent dependencies', () => {
  const remote = (name: string, fields: Partial<TaskExecutor> = {}): TaskExecutor => ({
    name,
    remote: true,
    execute: () => {
      throw new Error('never runs')
    },
    ...fields,
  })
  const floor = localExecutor()
  const where = (p: Placements, id: string): string | undefined => p.executors.get(id)?.name

  it('places a server’s dependants on it, through a group, and carries the server', () => {
    const dte = remote('dte', { servers: true })
    const p = placeTasks(
      graph(
        node('s#db', { persistent: {} }),
        node('s#api', { persistent: { readyWhen: 'up' } }, ['s#db']),
        { ...node('s#up', {}, ['s#api']), config: {} } as TaskNode,
        node('a#test', {}, ['s#up']),
        node('b#test', {}, ['s#api']),
      ),
      [dte, floor],
    )
    expect([where(p, 'a#test'), where(p, 'b#test')]).toEqual(['dte', 'dte'])
    expect(p.servers.get('a#test')?.map((n) => n.id)).toEqual(['s#db', 's#api'])
    expect([...p.carried].sort()).toEqual(['s#api', 's#db'])
  })

  it('the floor alone places what the general walk places', () => {
    const nodes = graph(
      node('s#db', { persistent: {} }),
      node('a#test', {}, ['s#db']),
      node('b#ship', { remote: 'only' }),
      node('c#ui', { interactive: true }),
      { ...node('g#all', {}, ['a#test']), config: {} } as TaskNode,
    )
    // A pass-through executor ahead of the floor forces the general walk.
    const declines: TaskExecutor = { ...remote('none'), accepts: () => false }
    const shape = (p: Placements) => [
      [...p.executors].map(([id, e]) => [id, e.name]),
      [...p.remoteOnlyNoop],
      [...p.remoteOnly, ...p.servers.keys(), ...p.carried],
    ]
    expect(shape(placeTasks(nodes, [floor]))).toEqual(shape(placeTasks(nodes, [declines, floor])))
    expect(shape(placeTasks(nodes, [floor]))).toEqual([
      [
        ['a#test', 'local'],
        ['b#ship', 'local'],
        ['c#ui', 'local'],
      ],
      ['b#ship'],
      [],
    ])
  })

  it('pins them here for an executor that carries none (control)', () => {
    const p = placeTasks(graph(node('s#db', { persistent: {} }), node('a#test', {}, ['s#db'])), [
      remote('pool'),
      floor,
    ])
    expect([where(p, 'a#test'), p.servers.size, p.carried.size]).toEqual(['local', 0, 0])
  })

  it('runs the server here too when one dependant stays here', () => {
    const p = placeTasks(
      graph(
        node('s#db', { persistent: {} }),
        node('a#test', {}, ['s#db']),
        node('b#test', { remote: false }, ['s#db']),
      ),
      [remote('dte', { servers: true }), floor],
    )
    expect([where(p, 'a#test'), where(p, 'b#test'), p.carried.size]).toEqual(['dte', 'local', 0])
    expect(p.servers.get('a#test')?.map((n) => n.id)).toEqual(['s#db'])
  })

  it('carries no sandboxed or requested server: those stay here with their dependants', () => {
    const requested = { ...node('s#dev', { persistent: {} }), requested: true } as TaskNode
    const p = placeTasks(
      graph(
        node('s#db', { persistent: {}, sandbox: { allow: { read: [] } } }),
        node('a#test', {}, ['s#db']),
        requested,
        node('b#test', {}, ['s#dev']),
      ),
      [remote('dte', { servers: true, sandbox: true }), floor],
    )
    expect([where(p, 'a#test'), where(p, 'b#test'), p.carried.size]).toEqual(['local', 'local', 0])
  })
})

// No task runs on a distributed run's orchestrator; only hits restore
// there (2026-10-24): an `exclusive` executor lifts every pin, and a
// task that would still land here refuses the run.
describe('placeTasks — an exclusive executor leaves this machine nothing', () => {
  const floor = localExecutor()
  const dte: TaskExecutor = {
    name: 'dte',
    remote: true,
    exclusive: true,
    servers: true,
    runtime: true,
    platforms: ['linux-x64'],
    execute: () => {
      throw new Error('never runs')
    },
  }
  const probed = {
    ...node('a#probe', {}),
    config: { exec: { command: 'true' }, inputs: { files: [], runtime: ['node -v'] } },
  } as TaskNode

  it('takes what pins here: remote: false, its dependants, interactive, sandboxed, probed, and their servers', () => {
    const p = placeTasks(
      graph(
        node('a#here', { remote: false }),
        node('a#above', {}, ['a#here']),
        node('a#tty', { interactive: true }),
        node('a#boxed', { sandbox: { allow: { read: [] } } }),
        probed,
        node('s#db', { persistent: {}, remote: false, sandbox: { allow: { read: [] } } }),
        node('a#test', {}, ['s#db']),
      ),
      [dte, floor],
    )
    expect([...p.executors].map(([id, e]) => [id, e.name])).toEqual(
      ['a#here', 'a#above', 'a#tty', 'a#boxed', 'a#probe', 'a#test'].map((id) => [id, 'dte']),
    )
    expect([...p.carried]).toEqual(['s#db'])
  })

  it('refuses the run for a task it cannot take, naming it and why', () => {
    const refuses =
      (n: TaskNode[], executors: TaskExecutor[] = [dte, floor]) =>
      () =>
        placeTasks(graph(...n), executors)
    expect(refuses([node('a#mac', { platforms: ['darwin-arm64'] })])).toThrow(
      "a#mac would run on this machine, and executor 'dte' runs every task elsewhere: it offers linux-x64, and exec.platforms asks for darwin-arm64",
    )
    expect(refuses([node('a#x', {})], [{ ...dte, accepts: () => false }, floor])).toThrow(
      'it declined the task',
    )
    expect(refuses([probed], [{ ...dte, runtime: false }, floor])).toThrow(
      'its key includes a runtime probe, which it does not check',
    )
    const dev = { ...node('s#dev', { persistent: {} }), requested: true } as TaskNode
    expect(refuses([dev])).toThrow(
      "s#dev would run on this machine, and executor 'dte' runs every task elsewhere: it starts a server only beside a task that needs it",
    )
    // Asked for beside a task that needs it, the server pinned the task,
    // and the run named the task, as folding a runtime probe (2026-10-24).
    expect(refuses([node('s#t', {}, ['s#dev']), dev])).toThrow(
      "s#dev would run on this machine, and executor 'dte' runs every task elsewhere: it starts a server only beside a task that needs it",
    )
  })
})

describe('placeTasks — what an executor is offered, and where a task lands', () => {
  const taker = (
    name: string,
    fields: Partial<TaskExecutor>,
    offered: TaskPlacement[] = [],
  ): TaskExecutor => ({
    name,
    accepts: (t) => {
      offered.push(t)
      return true
    },
    execute: () => {
      throw new Error('never runs')
    },
    ...fields,
  })

  it('accepts() is offered the task as placement describes it', () => {
    const offered: TaskPlacement[] = []
    const lib = node('lib#build', { command: 'tsc -b', sandbox: {} })
    ;(lib.config as { cache?: unknown }).cache = { inputs: { files: ['src/**'] } }
    placeTasks(graph(lib, node('app#lint', { command: 'oxlint' })), [taker('x', {}, offered)])
    expect(offered).toEqual([
      {
        taskId: 'lib#build',
        projectName: 'lib',
        projectDir: '/w/lib',
        command: 'tsc -b',
        pinnedLocal: true,
        cacheable: true,
      },
      {
        taskId: 'app#lint',
        projectName: 'app',
        projectDir: '/w/app',
        command: 'oxlint',
        pinnedLocal: false,
        cacheable: false,
      },
    ])
  })

  it('the first executor in declaration order that takes a task gets it', () => {
    const first = taker('first', {})
    const p = placeTasks(graph(node('a#build', {})), [first, taker('second', {})])
    expect(p.executors.get('a#build')).toBe(first)
  })

  it("an 'only' task is remote-only where a remote executor took it, a noop elsewhere", () => {
    const remote = taker('remote', {
      remote: true,
      accepts: (t) => t.taskId !== 'a#declined',
    })
    const p = placeTasks(
      graph(
        node('a#shipped', { remote: 'only' }),
        node('a#declined', { remote: 'only' }),
        node('a#plain', {}),
        node('a#here', { remote: false }),
      ),
      [
        remote,
        taker('declared-local', { remote: false, accepts: (t) => t.taskId !== 'a#declined' }),
        taker('local', {}),
      ],
    )
    expect([
      [...p.remoteOnly],
      [...p.remoteOnlyNoop],
      [...p.executors].map(([id, e]) => [id, e.name]),
    ]).toEqual([
      ['a#shipped'],
      ['a#declined'],
      [
        ['a#shipped', 'remote'],
        ['a#declined', 'local'],
        ['a#plain', 'remote'],
        ['a#here', 'declared-local'],
      ],
    ])
  })
})

describe('a remote executor that enforces the sandbox', () => {
  const remote = (sandbox: boolean): TaskExecutor => ({
    name: sandbox ? 'sandboxing' : 'plain',
    remote: true,
    sandbox,
    execute: () => {
      throw new Error('never runs')
    },
  })
  const local: TaskExecutor = { name: 'local', execute: () => Promise.reject(new Error('no')) }
  const g = () =>
    graph(
      node('a#lint', { sandbox: {} }),
      node('a#test', {}, ['a#lint']),
      node('a#dev', { persistent: {} }),
      node('a#here', { remote: false }),
    )

  it('is offered sandboxed tasks and their dependants, never what pins otherwise', () => {
    const p = placeTasks(g(), [remote(true), local])
    expect([...p.executors].map(([id, e]) => [id, e.name])).toEqual([
      ['a#lint', 'sandboxing'],
      ['a#test', 'sandboxing'],
      ['a#here', 'local'],
    ])
  })

  it('without it, both stay here', () => {
    const p = placeTasks(g(), [remote(false), local])
    expect(p.executors.get('a#lint')!.name).toBe('local')
    expect(p.executors.get('a#test')!.name).toBe('local')
  })
})

// Owner, 2026-10-22: nothing runs on a distributed run's orchestrator. A
// task that folds `bun --version` stayed on it; an executor that checks
// the probe where it runs the task takes it.
describe('a remote executor that checks runtime probes', () => {
  const remote = (runtime: boolean): TaskExecutor => ({
    name: runtime ? 'probing' : 'plain',
    remote: true,
    runtime,
    execute: () => {
      throw new Error('never runs')
    },
  })
  const local: TaskExecutor = { name: 'local', execute: () => Promise.reject(new Error('no')) }
  const probed = node('a#build', {})
  const g = () =>
    graph(
      {
        ...probed,
        config: { ...probed.config, inputs: { files: ['src/**'], runtime: ['bun --version'] } },
      } as TaskNode,
      node('a#here', { remote: false }),
    )

  it('is offered a task whose key folds a probe, never what pins otherwise', () => {
    const p = placeTasks(g(), [remote(true), local])
    expect([...p.executors].map(([id, e]) => [id, e.name])).toEqual([
      ['a#build', 'probing'],
      ['a#here', 'local'],
    ])
  })

  it('without it, the probed task stays here', () => {
    expect(placeTasks(g(), [remote(false), local]).executors.get('a#build')!.name).toBe('local')
  })
})

describe('hasPooledExecutor / poolOfPlacement', () => {
  const exec = (name: string, capacity?: number): TaskExecutor =>
    ({
      name,
      execute: () => {
        throw new Error('not called')
      },
      ...(capacity === undefined ? {} : { capacity }),
    }) as TaskExecutor

  it('a list is pooled when any executor declares a capacity', () => {
    expect([
      hasPooledExecutor([exec('local')]),
      hasPooledExecutor([exec('pool', 4), exec('local')]),
    ]).toEqual([false, true])
  })

  it("a task's pool is its executor's name and capacity; the floor's is none", () => {
    const poolOf = poolOfPlacement({
      executors: new Map([
        ['a#x', exec('pool-x', 4)],
        ['a#y', exec('pool-y', 2)],
        ['a#z', exec('local')],
      ]),
      remoteOnlyNoop: new Set(),
      remoteOnly: new Set(),
      servers: new Map(),
      carried: new Set(),
      otherPlatform: new Map(),
      unroutable: new Map(),
    })
    expect([poolOf('a#x'), poolOf('a#y'), poolOf('a#z'), poolOf('a#unplaced')]).toEqual([
      { name: 'pool-x', capacity: 4 },
      { name: 'pool-y', capacity: 2 },
      undefined,
      undefined,
    ])
  })

  it('two executors that share a name get two pools; one executor keeps one', () => {
    const first = exec('pool', 4)
    const second = exec('pool', 2)
    // A name that is already a repeat's spelling does not take it twice.
    const spelled = exec('pool#2', 1)
    const poolOf = poolOfPlacement({
      executors: new Map([
        ['a#x', first],
        ['a#w', spelled],
        ['a#y', second],
        ['a#z', first],
      ]),
      remoteOnlyNoop: new Set(),
      remoteOnly: new Set(),
      servers: new Map(),
      carried: new Set(),
      otherPlatform: new Map(),
      unroutable: new Map(),
    })
    expect([poolOf('a#x'), poolOf('a#w'), poolOf('a#y'), poolOf('a#z')]).toEqual([
      { name: 'pool', capacity: 4 },
      { name: 'pool#2', capacity: 1 },
      { name: 'pool#3', capacity: 2 },
      { name: 'pool', capacity: 4 },
    ])
  })
})

describe('locallyPlaced — "not remote", not "declared local"', () => {
  // The set feeds resolveDownloadModes as "these wrote in place, the outputs
  // are already here". `remote` is three-state: true, false, and UNDEFINED —
  // which is core's own floor, since localExecutor() declares no `remote` at
  // all. Ask "is it declared local" instead of "is it not remote" and every
  // task on the floor drops out, i.e. every task in a workspace with no
  // executor plugin; vx then believes it must fetch their outputs from a CAS
  // that never held them. Both call sites (`run()` and `--dry`) built this
  // inline from the same predicate, and the download tests hand the finished
  // set in as a literal, so nothing watched how it was BUILT.
  const exec = (name: string, remote?: boolean): TaskExecutor =>
    ({
      name,
      execute: () => {
        throw new Error('not called')
      },
      ...(remote === undefined ? {} : { remote }),
    }) as TaskExecutor

  const placements = (entries: [string, TaskExecutor][]): Placements => ({
    executors: new Map(entries),
    remoteOnlyNoop: new Set(),
    remoteOnly: new Set(),
    servers: new Map(),
    carried: new Set(),
    otherPlatform: new Map(),
    unroutable: new Map(),
  })

  it('counts the floor executor, which declares no `remote` at all', () => {
    const p = placements([
      ['a#floor', exec('local')],
      ['a#declared', exec('org/local', false)],
      ['a#remote', exec('org/remote', true)],
    ])
    expect([...locallyPlaced(p, ['a#floor', 'a#declared', 'a#remote'])].sort()).toEqual([
      'a#declared',
      'a#floor',
    ])
  })

  it('counts a task with no placement at all — it did not go anywhere remote', () => {
    // A group or persistent task is never placed; `get` answers undefined and
    // `?.remote` is undefined, so it is not remote and its outputs are here.
    const p = placements([['a#remote', exec('org/remote', true)]])
    expect([...locallyPlaced(p, ['a#unplaced', 'a#remote'])]).toEqual(['a#unplaced'])
  })
})

describe('UNPLACED_EXECUTOR — the stand-in that refuses', () => {
  it('throws, naming the task, rather than picking an executor', () => {
    // Its whole reason for existing, per the docblock: a group or persistent
    // task is never placed, and `run()` falls back to this one. It throws so
    // that a refactor routing such a task through the exec path fails loudly
    // "instead of shipping a localhost server to a worker" — a guarantee
    // nothing asserted, so a stand-in that quietly returned success would
    // have read as a green run.
    //
    // It throws SYNCHRONOUSLY, though `execute` is typed as returning a
    // promise: `executor.execute(req).catch(...)` in execute-task never sees
    // it, and it propagates straight out of the attempt. That is the right
    // shape for a refusal nobody should be handling, and it is why this
    // asserts on the call and not on a rejection.
    expect(() => UNPLACED_EXECUTOR.execute({ taskId: 'a#dev' } as never)).toThrow(
      /a#dev reached an executor without being placed/,
    )
  })
})
