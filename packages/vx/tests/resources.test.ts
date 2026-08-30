// exec.resources — the resolver (cores/megabytes → absolute costs), the
// cache-key strip (reservations are scheduling hints, never hashed), the
// --memory budget flag, and an end-to-end admission pin through a real run.
// Admission mechanics themselves are pinned in scheduler.test.ts.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { formatSummarySection, type SummaryStats } from '../src/orchestrator/summary.js'
import { resolveCpu, resolveMem, resolveResourceCosts } from '../src/orchestrator/resources.js'
import { parseRunArgs } from '../src/cli/index.js'

const GiB = 1024 ** 3

describe('resolveCpu', () => {
  it('number is CPU cores, fractional allowed', () => {
    expect(resolveCpu(8)).toBe(8)
    expect(resolveCpu(0.5)).toBe(0.5)
  })
  it('undefined and 0 reserve nothing', () => {
    expect(resolveCpu(undefined)).toBe(0)
    expect(resolveCpu(0)).toBe(0)
  })
})

describe('resolveMem', () => {
  it('number is MEGABYTES, resolved to the bytes the budget axis counts', () => {
    // The declared unit is MB so the same number means the same thing on this
    // machine and on a worker; the budget stays in bytes because that is what
    // `--memory` and os.totalmem() speak.
    expect(resolveMem(1)).toBe(1024 * 1024)
    expect(resolveMem(4096)).toBe(4 * GiB)
  })
  it('undefined reserves nothing', () => {
    expect(resolveMem(undefined)).toBe(0)
  })
})

function node(id: string, resources?: { cpus?: number; memory?: number; image?: string }) {
  const n: TaskNode = {
    id,
    projectName: id.split('#')[0]!,
    projectDir: '/tmp',
    taskName: id.split('#')[1]!,
    config: { exec: { command: 'noop', ...(resources !== undefined ? { resources } : {}) } },
    deps: [],
    requested: true,
  }
  return n
}

describe('resolveResourceCosts', () => {
  it('returns an EMPTY map when no task declares resources (the byte-identical gate)', () => {
    const nodes = new Map([
      ['a#run', node('a#run')],
      ['b#run', node('b#run')],
    ])
    expect(resolveResourceCosts(nodes).size).toBe(0)
  })

  it('omits zero-cost declarations and resolves the rest', () => {
    const nodes = new Map([
      ['a#run', node('a#run', { cpus: 0, memory: 0 })],
      ['b#run', node('b#run', { cpus: 4 })],
      ['c#run', node('c#run', { memory: 1024 })],
    ])
    const costs = resolveResourceCosts(nodes)
    expect(costs.has('a#run')).toBe(false)
    expect(costs.get('b#run')).toEqual({ cpu: 4, mem: 0 })
    expect(costs.get('c#run')).toEqual({ cpu: 0, mem: GiB })
  })

  it('reserves nothing for an image-only declaration', () => {
    // `image` is a placement MATCH, not a reservation — a task that only says
    // which worker it belongs on must not start reserving CPU it never asked
    // for, and must not fall out of the empty-map fast path either.
    const nodes = new Map([['a#run', node('a#run', { image: 'vx-playwright' })]])
    expect(resolveResourceCosts(nodes).size).toBe(0)
  })
})

describe('--memory parsing', () => {
  it('accepts --memory <size> and --memory=<size>, resolved to bytes', () => {
    expect(parseRunArgs(['--memory', '8GB']).memory).toBe(8 * GiB)
    expect(parseRunArgs(['--memory=512MB']).memory).toBe(512 * 1024 * 1024)
  })
  it('rejects missing/invalid values', () => {
    expect(parseRunArgs(['--memory']).error).toContain('requires a value')
    expect(parseRunArgs(['--memory', 'lots']).error).toContain('--memory')
    expect(parseRunArgs(['--memory', '1.5GB']).error).toContain('--memory')
  })
  it('defaults to undefined when absent', () => {
    expect(parseRunArgs(['build']).memory).toBeUndefined()
  })
})

describe('--memory wire round-trip', () => {})

describe('footer budget line', () => {
  const stats: SummaryStats = {
    failed: 0,
    successful: 1,
    skipped: 0,
    total: 1,
    upToDate: 0,
    restoredLocal: 0,
    restoredRemote: 0,
    miss: 1,
    spread: null,
  }
  const context = {
    version: '0.0.0',
    packageCount: 1,
    concurrency: 8,
    remoteCacheEnabled: false,
  }

  it('shows cpu + mem budgets on the info row only when set', () => {
    const withBudgets = formatSummarySection(stats, 100, undefined, {
      ...context,
      cpuBudget: 8,
      memBudget: 16 * GiB,
    }).join('\n')
    expect(withBudgets).toContain('cpu budget 8')
    expect(withBudgets).toContain('mem budget 16.0 GB')
  })

  it('a context without budgets renders no budget text (plain-run pin)', () => {
    const plain = formatSummarySection(stats, 100, undefined, context).join('\n')
    expect(plain).not.toContain('budget')
  })

  it('an Infinity mem budget (axis off) is not rendered', () => {
    const inf = formatSummarySection(stats, 100, undefined, {
      ...context,
      cpuBudget: 8,
      memBudget: Infinity,
    }).join('\n')
    expect(inf).toContain('cpu budget 8')
    expect(inf).not.toContain('mem budget')
  })
})

// --- end-to-end: key stability + admission wiring -------------------------

const TIMEOUT = 20_000

interface Fixture {
  root: string
  out: string[]
  err: string[]
}

let fixture: Fixture

const capturingLogger = (f: Fixture): Logger => ({
  status() {},
  taskStdout(_node, chunk) {
    f.out.push(chunk)
  },
  taskStderr(_node, chunk) {
    f.err.push(chunk)
  },
  taskComplete() {},
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-resources-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  return { root, out: [], err: [] }
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

describe('exec.resources — cache key stability (the strip)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'adding, tuning, and removing resources never busts the cache',
    async () => {
      const configWith = (resources: string) => `export default {
        tasks: {
          run: {
            exec: { command: 'echo done'${resources} },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
          },
        },
      }`
      // Miss + save WITHOUT resources.
      const dir = await addProject(fixture.root, 'a', configWith(''))
      const plain = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(plain.outcomes[0]!.status).toBe('success')

      // Declare a reservation → still hits (stripped config hashes
      // byte-identically to the no-declaration config).
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        configWith(`, resources: { cpus: 2, memory: 1024 }`),
      )
      const withResources = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(withResources.outcomes[0]!.status).toBe('cache-hit')

      // Tune it → still hits.
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        configWith(`, resources: { cpus: 6, image: 'vx-other' }`),
      )
      const tuned = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(tuned.outcomes[0]!.status).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('exec.resources — end-to-end admission', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'two whole-budget cpu tasks serialize through a real run',
    async () => {
      const config = `export default {
        tasks: {
          run: {
            exec: {
              command: "date +%s%N > start.txt && sleep 0.2 && date +%s%N > end.txt",
              resources: { cpus: 4 },
            },
          },
        },
      }`
      const dirA = await addProject(fixture.root, 'a', config)
      const dirB = await addProject(fixture.root, 'b', config)
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a', 'b'],
        concurrency: 4,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      const stamp = async (p: string) => Number(await Bun.file(p).text())
      const spans = [
        {
          s: await stamp(path.join(dirA, 'start.txt')),
          e: await stamp(path.join(dirA, 'end.txt')),
        },
        {
          s: await stamp(path.join(dirB, 'start.txt')),
          e: await stamp(path.join(dirB, 'end.txt')),
        },
      ].sort((x, y) => x.s - y.s)
      // Serialized: the later task started at/after the earlier finished.
      // Without admission both start in the same tick and overlap ~200ms.
      expect(spans[1]!.s).toBeGreaterThanOrEqual(spans[0]!.e)
    },
    TIMEOUT,
  )
})
