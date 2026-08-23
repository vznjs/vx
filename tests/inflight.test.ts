import { describe, it, expect } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { run, type Logger, type RunOptions } from '../src/orchestrator/index.js'

const silent: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

// A workspace with one cacheable task that takes ~0.5s and appends a byte
// to counter.txt every time it actually executes (a side effect outside
// the cache). After two concurrent runs, counter.txt's length = number of
// real executions. `withDep` adds an uncached upstream so the graph has a
// dependency edge — that makes shouldShortCircuit fire, so `slow` gets an
// up-front classify probe (preProbed) in each run.
async function makeWorkspace(opts?: { withDep?: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-inflight-'))
  spawnSync('git', ['init', '-q'], { cwd: root })
  spawnSync('git', ['config', 'user.email', 'a@b.c'], { cwd: root })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: root })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0' }),
  )
  await writeLocalWorkspace(root)
  await writeFile(path.join(root, 'input.txt'), 'in')
  await writeFile(
    path.join(root, 'vx.config.mjs'),
    [
      'export default {',
      '  tasks: {',
      ...(opts?.withDep ? ["    pre: { exec: { command: 'echo pre' } },"] : []),
      '    slow: {',
      "      exec: { command: 'sleep 0.5 && printf x >> counter.txt && printf done > out.txt' },",
      ...(opts?.withDep ? ["      dependsOn: ['pre'],"] : []),
      "      cache: { inputs: { files: ['input.txt'] }, outputs: { files: ['out.txt'] } },",
      '    },',
      '  },',
      '}',
      '',
    ].join('\n'),
  )
  spawnSync('git', ['add', '-A'], { cwd: root })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return root
}

async function counter(root: string): Promise<string> {
  try {
    return await readFile(path.join(root, 'counter.txt'), 'utf8')
  } catch {
    return ''
  }
}

describe('in-flight dedup', () => {
  it('a shared registry makes a concurrent duplicate task execute ONCE', async () => {
    const root = await makeWorkspace()
    try {
      const inflight = new Map<string, Promise<void>>()
      const opts: RunOptions = { cwd: root, tasks: ['slow'], log: silent, inflight }
      const [a, b] = await Promise.all([run(opts), run(opts)])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      // One real execution; the second run joined the first and restored.
      expect(await counter(root)).toBe('x')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a joiner with a stale up-front probe (dep edge → preProbed miss) still cache-hits', async () => {
    // Regression: with a dependency edge in the graph, the local
    // short-circuit classifies `slow` up front and records a CONFIRMED
    // MISS (preProbed hit:null) in BOTH concurrent runs. The joiner that
    // awaited the sibling's barrier must NOT reuse that stale probe — it
    // would skip the lazy cache.get and re-execute the task the sibling
    // just saved. The join path drops preProbed so the probe runs fresh.
    const root = await makeWorkspace({ withDep: true })
    try {
      const inflight = new Map<string, Promise<void>>()
      const opts: RunOptions = { cwd: root, tasks: ['slow'], log: silent, inflight }
      const [a, b] = await Promise.all([run(opts), run(opts)])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      // Exactly one real execution…
      expect(await counter(root)).toBe('x')
      // …and the joiner reported a cache hit on the sibling's artifact.
      const statuses = [...a.outcomes, ...b.outcomes]
        .filter((o) => o.node.taskName === 'slow')
        .map((o) => o.status)
        .sort()
      expect(statuses).toEqual(['cache-hit', 'success'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('without a shared registry, concurrent duplicates BOTH execute', async () => {
    const root = await makeWorkspace()
    try {
      // No inflight map → no dedup. Both runs cache-miss concurrently
      // (neither has saved yet) and execute. This is the control that
      // proves the dedup above is what changed the outcome.
      const opts: RunOptions = { cwd: root, tasks: ['slow'], log: silent }
      await Promise.all([run(opts), run(opts)])
      expect(await counter(root)).toBe('xx')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
