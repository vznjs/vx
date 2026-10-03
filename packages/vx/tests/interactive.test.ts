// `exec.interactive` (Turbo #1235, Nx #8269): a task that reads the
// terminal gets it when vx's stdin is a TTY, alone, here, uncached. The
// TTY itself is driven on a pseudo-terminal in terminal.unsafe.test.ts;
// these rows hold the rest without one.
import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { localExecutor } from '../src/exec/index.js'
import type { TaskExecutor } from '../src/exec/executor.js'
import { runGraph, type TaskOutcome } from '../src/graph/scheduler.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { placeTasks, terminalHolders } from '../src/orchestrator/placement.js'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

function node(id: string, exec: Record<string, unknown> = {}, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    taskName: id.split('#')[1]!,
    projectDir: '/w/' + id.split('#')[0]!,
    deps,
    requested: true,
    config: { exec: { command: 'true', ...exec } },
  } as unknown as TaskNode
}
const graph = (...ns: TaskNode[]): Map<string, TaskNode> => new Map(ns.map((n) => [n.id, n]))

const refusal = (task: Record<string, unknown>): string => {
  try {
    validateProjectConfig({ tasks: { t: task } } as never, 'vx.config.ts')
  } catch (err) {
    return (err as Error).message
  }
  return 'ok'
}

describe('exec.interactive in the schema', () => {
  it('refuses cache, sandbox and readyWhen beside it, and nothing else', () => {
    const cache = { inputs: { files: ['src/**'] }, outputs: { files: [] } }
    expect({
      cache: refusal({ exec: { command: 'x', interactive: true }, cache }),
      sandbox: refusal({ exec: { command: 'x', interactive: true, sandbox: {} } }),
      readyWhen: refusal({
        exec: { command: 'x', interactive: true, persistent: { readyWhen: 'up' } },
      }),
      shape: refusal({ exec: { command: 'x', interactive: 'yes' } }),
      // CONTROLS: a server with no readyWhen, a timeout, and `false` beside a cache.
      server: refusal({ exec: { command: 'x', interactive: true, persistent: {} } }),
      timeout: refusal({ exec: { command: 'x', interactive: true, timeout: 1000 } }),
      off: refusal({ exec: { command: 'x', interactive: false }, cache }),
    }).toEqual({
      cache:
        'vx.config.ts: tasks.t: `cache` is not allowed on an interactive task — what it does depends on what is typed, which no key holds',
      sandbox:
        "vx.config.ts: tasks.t: `sandbox` is not allowed on an interactive task — a sandboxed task's output passes through vx, and an interactive one writes to the terminal",
      readyWhen:
        'vx.config.ts: tasks.t: `persistent.readyWhen` is not allowed on an interactive task — its output goes to the terminal, so vx reads none of it; it is ready once spawned',
      shape: 'vx.config.ts: tasks.t.exec.interactive must be a boolean (or omitted)',
      server: 'ok',
      timeout: 'ok',
      off: 'ok',
    })
  })
})

describe('placement', () => {
  it('an interactive task goes to the local floor, past a plugin that takes everything', () => {
    const asked: string[] = []
    const plugin: TaskExecutor = {
      name: 'takes-all',
      accepts: (t) => {
        asked.push(t.taskId)
        return true
      },
      execute: () => {
        throw new Error('never runs')
      },
    }
    const floor = localExecutor()
    const p = placeTasks(graph(node('a#ask', { interactive: true }), node('b#build')), [
      plugin,
      floor,
    ])
    // CONTROL: b#build is the plugin's, so the plugin was there to take a#ask.
    expect({
      ask: p.executors.get('a#ask') === floor,
      build: p.executors.get('b#build') === plugin,
      asked,
    }).toEqual({ ask: true, build: true, asked: ['b#build'] })
  })
})

describe('terminalHolders', () => {
  const server = (id: string, deps: string[] = []): TaskNode =>
    node(id, { interactive: true, persistent: {} }, deps)
  const ask = (id: string, deps: string[] = []): TaskNode => node(id, { interactive: true }, deps)

  it('off a TTY nothing holds the terminal, whatever the run asks', () => {
    expect(terminalHolders(graph(server('a#dev'), server('b#dev')), false)).toEqual(new Set())
  })

  it('on one, every interactive task holds it; one-shots take turns', () => {
    expect(terminalHolders(graph(ask('a#seed'), ask('b#seed'), node('c#build')), true)).toEqual(
      new Set(['a#seed', 'b#seed']),
    )
  })

  it('refuses two interactive servers before any task runs', () => {
    expect(() => terminalHolders(graph(server('a#dev'), server('b#dev')), true)).toThrow(
      'a#dev and b#dev are persistent and interactive: a server holds the terminal until the run ends, so one run can hold one — run them in separate terminals',
    )
  })

  it('refuses an interactive task an interactive server does not wait for', () => {
    let message = ''
    try {
      terminalHolders(graph(server('a#dev', ['a#gen']), node('a#gen'), ask('b#seed')), true)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toBe(
      'a#dev is persistent and interactive, so it holds the terminal until the run ends, and b#seed would ask for it too: make a#dev depend on it, or run it on its own',
    )
  })

  it('takes an interactive task the server depends on, through a plain one', () => {
    expect(
      terminalHolders(
        graph(server('a#dev', ['a#gen']), node('a#gen', {}, ['b#seed']), ask('b#seed')),
        true,
      ),
    ).toEqual(new Set(['a#dev', 'b#seed']))
  })
})

describe('the scheduler holds the terminal for one task', () => {
  const ok = (n: TaskNode): TaskOutcome => ({
    node: n,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
  })
  const trace = async (exclusive?: ReadonlySet<string>) => {
    const running = new Set<string>()
    const beside: Record<string, string[]> = {}
    await runGraph({
      nodes: graph(node('a#one'), node('b#ask'), node('c#two')),
      concurrency: 4,
      // a#one starts first, so b#ask meets a running task and must wait.
      priorities: new Map([['a#one', 1]]),
      ...(exclusive !== undefined ? { exclusive } : {}),
      execute: async (n) => {
        beside[n.id] = [...running]
        for (const other of running) beside[other]!.push(n.id)
        running.add(n.id)
        await new Promise((r) => setTimeout(r, 15))
        running.delete(n.id)
        return ok(n)
      },
    })
    return beside['b#ask']!.sort()
  }

  it('starts it once nothing runs, and starts nothing beside it', async () => {
    expect(await trace(new Set(['b#ask']))).toEqual([])
    // CONTROL: without the set it runs beside the others.
    expect(await trace()).toEqual(['a#one', 'c#two'])
  })
})

describe('a run', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-interactive-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const project = (name: string, extra: string): Promise<string> =>
    addProject(root, name, {
      config: `
        export default {
          tasks: {
            go: {
              exec: {
                // Each holds until all three have started (2 s at most), so
                // tasks run side by side overlap whatever the machine's
                // load; a fixed sleep let a slow runner finish a and c
                // before b started, and the control read b as alone.
                command: 'echo "${name} start" >> ../../order.log; echo said-${name}; for i in $(seq 40); do [ $(grep -c start ../../order.log) -ge 3 ] && break; sleep 0.05; done; echo "${name} end" >> ../../order.log',
                ${extra}
              },
            },
          },
        }
      `,
    })

  const go = async (tty: boolean) => {
    await rm(path.join(root, 'order.log'), { force: true })
    const said: string[] = []
    const log: Logger = {
      status() {},
      taskStdout(_n, chunk) {
        said.push(chunk.trim())
      },
      taskStderr() {},
      taskComplete() {},
    }
    const summary = await run({
      cwd: root,
      tasks: ['go'],
      concurrency: 4,
      log,
      ...(tty ? { tty: true } : {}),
    })
    const order = readFileSync(path.join(root, 'order.log'), 'utf8').trim().split('\n')
    const at = order.indexOf('b start')
    return {
      ok: summary.ok,
      // b's end follows its start with nothing between: it ran alone.
      alone: order[at + 1] === 'b end',
      said: said.filter((s) => s.startsWith('said-')).sort(),
    }
  }

  it('on a TTY runs the interactive task alone, its output past vx; off one, as any task', async () => {
    await project('a', '')
    await project('b', 'interactive: true,')
    await project('c', '')
    expect(await go(true)).toEqual({ ok: true, alone: true, said: ['said-a', 'said-c'] })
    // CONTROL, the CI path: beside the others, its output through vx.
    expect(await go(false)).toEqual({
      ok: true,
      alone: false,
      said: ['said-a', 'said-b', 'said-c'],
    })
  }, 20_000)
})
