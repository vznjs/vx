// `orchestrator/persistent.ts` driven directly: which persistent children a
// run keeps, and how the rest go down — SIGTERM first so a server can clean
// up, SIGKILL past the grace, and not returning before the killed ones have
// exited. The e2e rows (keep-alive, persistent, task-tree-kill) set
// VX_KILL_GRACE_MS, so the default grace is pinned here once, unset.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import { selectKeepAlive, shutdownPersistent } from '../src/orchestrator/persistent.js'
import { restoreEnv } from './helpers/env.js'

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
    ({ id, requested, ...(surfaced === undefined ? {} : { surfaced }) }) as TaskNode
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
})
