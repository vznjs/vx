// `orchestrator/persistent.ts` driven directly: which persistent children a
// run keeps, and how the rest go down — SIGTERM first so a server can clean
// up, SIGKILL past the grace, and not returning before the killed ones have
// exited. The e2e rows (keep-alive, persistent, task-tree-kill) set
// VX_KILL_GRACE_MS, so the default grace is pinned here once, unset.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import * as killTreeModule from '../src/exec/kill-tree.js'
import { selectKeepAlive, shutdownPersistent } from '../src/orchestrator/persistent.js'
import { restoreEnv } from './helpers/env.js'

const realHoldGroups = killTreeModule.holdGroups
const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-persistent-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const spawnGroup = (script: string) =>
  Bun.spawn(['sh', '-c', script], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] })

/** A server that ignores SIGTERM, and says it is up by writing `ready`. */
async function stubborn(tag: string): Promise<ReturnType<typeof Bun.spawn>> {
  const ready = path.join(dir, `${tag}.ready`)
  const child = spawnGroup(`trap '' TERM; touch '${ready}'; while :; do sleep 0.05; done`)
  while (!existsSync(ready)) await Bun.sleep(5)
  return child
}

describe('selectKeepAlive', () => {
  const node = (id: string, requested: boolean, surfaced?: boolean) =>
    ({
      id,
      deps: [],
      requested,
      ...(surfaced === undefined ? {} : { surfaced }),
    }) as unknown as TaskNode
  it('keeps what was requested or surfaced, and only in the foreground', () => {
    const a = {} as ReturnType<typeof Bun.spawn>
    const b = {} as ReturnType<typeof Bun.spawn>
    const c = {} as ReturnType<typeof Bun.spawn>
    const registry = new Map([
      ['p#req', a],
      ['p#shown', b],
      ['p#dep', c],
    ])
    const nodes = new Map([
      ['p#req', node('p#req', true)],
      ['p#shown', node('p#shown', false, true)],
      ['p#dep', node('p#dep', false)],
    ])
    const kept = selectKeepAlive(registry, nodes, true)
    expect(kept.nodes.map((n) => n.id)).toEqual(['p#req', 'p#shown'])
    expect(kept.children).toEqual([a, b])
    expect(selectKeepAlive(registry, nodes, false)).toEqual({ nodes: [], children: [] })
  })

  // C-46: `vx run dev --filter app` (or `--affected` with only app changed)
  // kept app#dev and stopped the api#dev it depends on at the end of the
  // graph, so the kept server ran against a dead API. A kept server keeps
  // its persistent dependencies, through groups; a one-shot's do not stay
  // on its account, since it has finished with them.
  it('keeps the persistent tasks a kept one depends on, through groups', () => {
    const task = (
      id: string,
      deps: string[],
      opts: { requested?: boolean; group?: boolean } = {},
    ) =>
      ({
        id,
        deps,
        requested: opts.requested === true,
        config: opts.group === true ? {} : { exec: { command: 'x' } },
      }) as unknown as TaskNode
    const graph = [
      task('app#dev', ['app#servers', 'app#build'], { requested: true }),
      task('app#servers', ['api#dev'], { group: true }),
      task('api#dev', ['db#dev']),
      task('db#dev', []),
      task('app#build', ['gen#srv']),
      task('gen#srv', []),
      task('app#e2e', ['mock#srv'], { requested: true }),
      task('mock#srv', []),
    ]
    const nodes = new Map(graph.map((n) => [n.id, n]))
    const ids = ['mock#srv', 'gen#srv', 'db#dev', 'api#dev', 'app#dev']
    const children = ids.map((_, i) => ({ pid: i + 1 }) as ReturnType<typeof Bun.spawn>)
    const registry = new Map(ids.map((id, i) => [id, children[i]!]))
    const kept = selectKeepAlive(registry, nodes, true)
    expect(kept.nodes.map((n) => n.id)).toEqual(['db#dev', 'api#dev', 'app#dev'])
    expect(kept.children).toEqual(children.slice(2))
  })

  // C-52: `vx run app#dev` over `dev: { dependsOn: ['^dev'] }` (a group)
  // started api#dev and db#dev, then stopped both at the end of the graph
  // and exited 0. A requested group stands for its servers, through
  // nested groups; a one-shot under it still keeps none of its own.
  it('keeps the persistent tasks a requested group stands for', () => {
    const task = (
      id: string,
      deps: string[],
      opts: { requested?: boolean; group?: boolean } = {},
    ) =>
      ({
        id,
        deps,
        requested: opts.requested === true,
        config: opts.group === true ? {} : { exec: { command: 'x' } },
      }) as unknown as TaskNode
    const graph = [
      task('app#dev', ['api#dev', 'app#more', 'app#build'], { requested: true, group: true }),
      task('app#more', ['db#dev'], { group: true }),
      task('api#dev', []),
      task('db#dev', []),
      task('app#build', ['gen#srv']),
      task('gen#srv', []),
      task('lone#dev', []),
    ]
    const nodes = new Map(graph.map((n) => [n.id, n]))
    const ids = ['gen#srv', 'db#dev', 'api#dev', 'lone#dev']
    const children = ids.map((_, i) => ({ pid: i + 1 }) as ReturnType<typeof Bun.spawn>)
    const registry = new Map(ids.map((id, i) => [id, children[i]!]))
    const kept = selectKeepAlive(registry, nodes, true)
    expect(kept.nodes.map((n) => n.id)).toEqual(['db#dev', 'api#dev'])
    expect(kept.children).toEqual(children.slice(1, 3))
  })
})

describe('shutdownPersistent', () => {
  it('asks politely first: a server that traps SIGTERM gets to clean up', async () => {
    const ready = path.join(dir, 'polite.ready')
    const cleaned = path.join(dir, 'polite.cleaned')
    const child = spawnGroup(
      `trap "touch '${cleaned}'; exit 0" TERM; touch '${ready}'; while :; do sleep 0.05; done`,
    )
    while (!existsSync(ready)) await Bun.sleep(5)
    await shutdownPersistent(new Map([['p#dev', child]]), [], 5_000)
    expect(existsSync(cleaned)).toBe(true)
  })

  it('does not return before a server it had to SIGKILL has exited', async () => {
    const child = await stubborn('killed')
    await shutdownPersistent(new Map([['p#dev', child]]), [], 100)
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('the default grace is two seconds, not the run-long wait a larger one would be', async () => {
    const saved = { ...process.env }
    delete process.env['VX_KILL_GRACE_MS']
    try {
      const child = await stubborn('default')
      const t0 = Date.now()
      await shutdownPersistent(new Map([['p#dev', child]]), [])
      const took = Date.now() - t0
      expect(child.signalCode).toBe('SIGKILL')
      expect(took).toBeGreaterThanOrEqual(1_900)
      expect(took).toBeLessThan(8_000)
    } finally {
      restoreEnv(saved)
    }
  }, 15_000)

  // C-46: the e2e rows set VX_KILL_GRACE_MS and pass on the 2 s default
  // too, only slower, so a default that ignored it survived them.
  it('VX_KILL_GRACE_MS shortens the default grace', async () => {
    const saved = { ...process.env }
    process.env['VX_KILL_GRACE_MS'] = '100'
    try {
      const child = await stubborn('env')
      const t0 = Date.now()
      await shutdownPersistent(new Map([['p#dev', child]]), [])
      expect(child.signalCode).toBe('SIGKILL')
      expect(Date.now() - t0).toBeLessThan(1_500)
    } finally {
      restoreEnv(saved)
    }
  }, 15_000)

  // C-46: the hold keeps a group on the guard's list through the grace
  // (kill-tree.ts); never let go, the dead group's number stayed listed
  // and vx's exit SIGKILLed whatever group the kernel gave it next. Only a
  // reused pid shows that, so the row counts the let-go instead.
  it('lets go of the groups it held once the SIGKILL sweep has settled', async () => {
    const child = await stubborn('held')
    const exitedAtLetGo: Array<number | string | null> = []
    const hold = spyOn(killTreeModule, 'holdGroups').mockImplementation((children) => {
      const letGo = realHoldGroups(children)
      return () => {
        exitedAtLetGo.push(child.exitCode ?? child.signalCode)
        letGo()
      }
    })
    try {
      await shutdownPersistent(new Map([['p#dev', child]]), [], 100)
    } finally {
      hold.mockRestore()
    }
    expect(exitedAtLetGo).toEqual(['SIGKILL'])
  })
})
