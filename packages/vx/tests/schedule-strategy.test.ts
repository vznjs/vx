// `schedule` in vx.workspace.ts picks the ready-queue baseline. One graph
// where each strategy starts a different root first, one worker: the
// first dispatch names the strategy. A `schedule` plugin's weights still
// come first under every strategy.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runGraph, type TaskOutcome } from '../src/graph/scheduler.js'
import type { ScheduleStrategy } from '../src/graph/priorities.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { validateWorkspace } from '../src/workspace/config-schema.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

function node(id: string, deps: string[] = []): TaskNode {
  return {
    id,
    projectName: id.split('#')[0]!,
    projectDir: '/tmp',
    taskName: id.split('#')[1]!,
    config: { exec: { command: 'noop' } },
    deps,
    requested: true,
  }
}

// Roots, in insertion order:
//   x#solo  nothing after it                     (first ready)
//   a#p     a chain of three below it            (deepest)
//   b#p     three direct dependents              (most direct)
//   c#p     one dependent with four below it     (most work: five)
const GRAPH = [
  node('x#solo'),
  node('a#p'),
  node('a#c1', ['a#p']),
  node('a#c2', ['a#c1']),
  node('a#c3', ['a#c2']),
  node('b#p'),
  ...[1, 2, 3].map((i) => node(`b#d${i}`, ['b#p'])),
  node('c#p'),
  node('c#q', ['c#p']),
  ...[1, 2, 3, 4].map((i) => node(`c#r${i}`, ['c#q'])),
]

async function firstStarted(
  strategy: ScheduleStrategy | undefined,
  priorities?: Map<string, number>,
): Promise<string> {
  const order: string[] = []
  await runGraph({
    nodes: new Map(GRAPH.map((n) => [n.id, n])),
    concurrency: 1,
    ...(strategy !== undefined ? { strategy } : {}),
    ...(priorities !== undefined ? { priorities } : {}),
    execute: async (n): Promise<TaskOutcome> => {
      order.push(n.id)
      return { node: n, status: 'success', exitCode: 0, durationMs: 0, hash: `h-${n.id}` }
    },
  })
  expect(order).toHaveLength(GRAPH.length)
  return order[0]!
}

describe('schedule strategy', () => {
  it('each strategy starts its own root first', async () => {
    expect({
      default: await firstStarted(undefined),
      'most-work': await firstStarted('most-work'),
      'critical-path': await firstStarted('critical-path'),
      'direct-dependents': await firstStarted('direct-dependents'),
      'ready-order': await firstStarted('ready-order'),
    }).toEqual({
      default: 'c#p',
      'most-work': 'c#p',
      'critical-path': 'a#p',
      'direct-dependents': 'b#p',
      'ready-order': 'x#solo',
    })
  })

  it("a schedule plugin's weights come first under every strategy", async () => {
    const weights = new Map([['x#solo', 1]])
    const strategies: ScheduleStrategy[] = [
      'most-work',
      'critical-path',
      'direct-dependents',
      'ready-order',
    ]
    for (const s of strategies) expect(await firstStarted(s, weights)).toBe('x#solo')
  })

  it('the workspace names one of the four, or is refused', () => {
    for (const s of ['most-work', 'critical-path', 'direct-dependents', 'ready-order'] as const) {
      expect(() => validateWorkspace({ schedule: s }, 'vx.workspace.ts')).not.toThrow()
    }
    let message = ''
    try {
      validateWorkspace({ schedule: 'fastest' } as never, 'vx.workspace.ts')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toBe(
      "vx.workspace.ts: `schedule` must be one of 'most-work', 'critical-path', 'direct-dependents', 'ready-order'",
    )
  })
})

describe('schedule in vx.workspace.mjs reaches the run', () => {
  const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
  const config = `const t = (n, deps = []) => ({ dependsOn: deps, exec: { command: 'echo ' + n + ' >> ../../order.txt' } })
export default { tasks: { solo: t('solo'), deep: t('deep'), d1: t('d1', ['deep']), d2: t('d2', ['d1']), all: { dependsOn: ['solo', 'd2'] } } }
`
  async function firstRun(workspace: string): Promise<string> {
    const root = await makeWorkspace({ prefix: 'vx-schedule-', workspaceFile: false })
    try {
      await writeFile(path.join(root, 'vx.workspace.mjs'), workspace)
      await addProject(root, 'p', { config })
      const proc = Bun.spawn([process.execPath, BIN, 'run', 'all', '--all', '--concurrency', '1'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1' },
      })
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      expect(`${code}\n${err}`).toStartWith('0\n')
      return (await Bun.file(path.join(root, 'order.txt')).text()).split('\n')[0]!
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('ready-order starts the first ready task; the default the one with work behind it', async () => {
    expect(await firstRun(`export default { schedule: 'ready-order' }\n`)).toBe('solo')
    expect(await firstRun(`export default {}\n`)).toBe('deep')
  }, 30_000)
})
