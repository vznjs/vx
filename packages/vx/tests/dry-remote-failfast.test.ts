// `--dry` against a remote that fails: the plan pays the remote's timeout
// about as often as the run does, not once per key. A failed batch probe
// left every key asked again one at a time (10 tasks, a 2 s timeout: 22 s
// for the plan, 2.3 s for the run), and a remote with no batch probe was
// asked per key in series. A failed batch still falls back to each key
// (`orchestrator-remote.test.ts` pins that); those asks now go out at once.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache, GitFilesCache, type RemoteCacheLayer } from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import { plan } from '../src/orchestrator/plan.js'
import { layeredOver } from './helpers/layered.js'

const WS_ROOT = '/vx-dry-failfast'
const PROJECT_DIR = `${WS_ROOT}/packages/p`
const TASKS = 10

let root: string
let local: Cache

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-dry-failfast-'))
  local = new Cache(path.join(root, 'cache'))
})
afterEach(async () => {
  local.close()
  await rm(root, { recursive: true, force: true })
})

function nodes(): Map<string, TaskNode> {
  const out = new Map<string, TaskNode>()
  for (let i = 0; i < TASKS; i++) {
    const id = `p#t${i}`
    out.set(id, {
      id,
      projectName: 'p',
      projectDir: PROJECT_DIR,
      taskName: `t${i}`,
      config: {
        exec: { command: `echo ${i}` },
        inputs: { files: ['src/**'] },
        outputs: { files: [] },
        cache: true,
      },
      deps: [],
      requested: true,
    } as unknown as TaskNode)
  }
  return out
}

/** A remote whose every probe stalls, then fails, counting each. */
/**
 * A remote whose key asks all stall until every key is asked, then fail:
 * asks made at once settle, asks made one after another wait forever (the
 * test's timeout), and no clock is read. A batch probe fails at once.
 */
function stalling(batch: boolean): RemoteCacheLayer & { calls: number } {
  let asking = 0
  let release!: () => void
  const all = new Promise<void>((resolve) => (release = resolve))
  const key = async (): Promise<never> => {
    remote.calls++
    if (++asking === TASKS) release()
    await all
    throw new Error('timed out')
  }
  const remote = {
    calls: 0,
    has: key,
    ...(batch
      ? {
          hasMany: async (): Promise<never> => {
            remote.calls++
            throw new Error('timed out')
          },
        }
      : {}),
    get: key,
    put: key,
  } as RemoteCacheLayer & { calls: number }
  return remote
}

async function dry(remote: RemoteCacheLayer): Promise<{ statuses: string[] }> {
  const git = new GitFilesCache()
  git.set(PROJECT_DIR, [])
  git.set(WS_ROOT, [])
  const p = await plan({
    nodes: nodes(),
    workspaceRoot: WS_ROOT,
    cache: layeredOver(local, remote, { onRemoteError: () => {} }),
    nestedDirsByProject: new Map(),
    gitFilesCache: git,
  })
  return { statuses: p.tasks.map((t) => t.cacheStatus) }
}

describe('--dry against a failing remote', () => {
  it('a failed batch probe asks the keys at once, not one after another', async () => {
    const remote = stalling(true)
    const { statuses } = await dry(remote)
    expect(statuses).toEqual(Array(TASKS).fill('miss'))
    expect(remote.calls).toBe(1 + TASKS)
  })

  it('a remote with no batch probe is asked its keys at once, not one after another', async () => {
    const remote = stalling(false)
    const { statuses } = await dry(remote)
    expect(statuses).toEqual(Array(TASKS).fill('miss'))
    expect(remote.calls).toBe(TASKS)
  })
})
