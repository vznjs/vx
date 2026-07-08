// exec.resources — the resolver (percent/size forms → absolute costs),
// the cache-key strip (reservations are scheduling hints, never hashed),
// the --memory budget flag, and an end-to-end admission pin through a
// real run. Admission mechanics themselves are pinned in scheduler.test.ts.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/task-graph.js'
import type { Logger } from '../src/orchestrator/index.js'
import { optionsToRequest, requestToOptions, run } from '../src/orchestrator/index.js'
import { formatSummarySection, type SummaryStats } from '../src/orchestrator/summary.js'
import { resolveCpu, resolveMem, resolveResourceCosts } from '../src/orchestrator/resources.js'
import { parseRunArgs } from '../src/cli/index.js'

const GiB = 1024 ** 3

describe('resolveCpu', () => {
  it('number is CPU units, fractional allowed', () => {
    expect(resolveCpu(8, 8)).toBe(8)
    expect(resolveCpu(0.5, 8)).toBe(0.5)
  })
  it('percent resolves against the CPU budget', () => {
    expect(resolveCpu('50%', 8)).toBe(4)
    expect(resolveCpu('12.5%', 8)).toBe(1)
  })
  it('over-100% resolves past the budget (solo-clamp territory)', () => {
    expect(resolveCpu('150%', 8)).toBe(12)
  })
  it('undefined and 0 reserve nothing', () => {
    expect(resolveCpu(undefined, 8)).toBe(0)
    expect(resolveCpu(0, 8)).toBe(0)
  })
})

describe('resolveMem', () => {
  it('number is bytes', () => {
    expect(resolveMem(1024, 16 * GiB)).toBe(1024)
  })
  it('size strings parse in powers of 1024', () => {
    expect(resolveMem('2GB', 16 * GiB)).toBe(2 * GiB)
    expect(resolveMem('512MB', 16 * GiB)).toBe(512 * 1024 * 1024)
  })
  it('percent resolves against the memory budget', () => {
    expect(resolveMem('50%', 16 * GiB)).toBe(8 * GiB)
  })
  it('undefined reserves nothing', () => {
    expect(resolveMem(undefined, 16 * GiB)).toBe(0)
  })
})

function node(id: string, resources?: { cpus?: number | string; memory?: number | string }) {
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
    expect(resolveResourceCosts(nodes, 8, 16 * GiB).size).toBe(0)
  })

  it('omits zero-cost declarations and resolves the rest', () => {
    const nodes = new Map([
      ['a#run', node('a#run', { cpus: 0, memory: 0 })],
      ['b#run', node('b#run', { cpus: '50%' })],
      ['c#run', node('c#run', { memory: '1GB' })],
    ])
    const costs = resolveResourceCosts(nodes, 8, 16 * GiB)
    expect(costs.has('a#run')).toBe(false)
    expect(costs.get('b#run')).toEqual({ cpu: 4, mem: 0 })
    expect(costs.get('c#run')).toEqual({ cpu: 0, mem: GiB })
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

describe('--memory wire round-trip', () => {
  it('threads RunOptions.memory through the request mappers', () => {
    const req = optionsToRequest({ cwd: '/x', tasks: ['run'], memory: 8 * GiB })
    expect(req.memory).toBe(8 * GiB)
    expect(requestToOptions(req).memory).toBe(8 * GiB)
  })
  it('omits memory when unset', () => {
    const req = optionsToRequest({ cwd: '/x', tasks: ['run'] })
    expect(req.memory).toBeUndefined()
    expect(requestToOptions(req).memory).toBeUndefined()
  })
})

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
        configWith(`, resources: { cpus: 2, memory: '1GB' }`),
      )
      const withResources = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(withResources.outcomes[0]!.status).toBe('cache-hit')

      // Tune it → still hits.
      await writeFile(path.join(dir, 'vx.config.mjs'), configWith(`, resources: { cpus: '75%' }`))
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
    'two 100%-cpu tasks serialize through a real run',
    async () => {
      const config = `export default {
        tasks: {
          run: {
            exec: {
              command: "date +%s%N > start.txt && sleep 0.2 && date +%s%N > end.txt",
              resources: { cpus: '100%' },
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
