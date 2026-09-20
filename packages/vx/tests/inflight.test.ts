import { describe, it, expect } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gitInitCommit } from './helpers/workspace.js'
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
  gitInitCommit(root)
  return root
}

async function counter(root: string): Promise<string> {
  try {
    return await readFile(path.join(root, 'counter.txt'), 'utf8')
  } catch {
    return ''
  }
}

// Two projects, so a restore-tier task can exist with an UNFINISHED
// dependency. `app#build`'s key is stable (its inputs live in its own
// directory, `lib`'s declared output in `lib`'s), and `cache.inputs.tasks: []`
// folds no upstream key, so editing `lib/src.txt` evicts `lib#build` alone
// and leaves `app#build` a warm, confirmed local hit — the restore tier.
// The scheduler makes it ready at once, dep-independently, so its `upstream`
// array holds a HOLE where `lib#build`'s outcome will go.
async function makeCrossProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-inflight-x-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', workspaces: ['packages/*'] }),
  )
  await writeLocalWorkspace(root)
  const pkgs: Array<[string, string[]]> = [
    [
      'lib',
      [
        'export default {',
        '  tasks: {',
        '    build: {',
        "      exec: { command: 'sleep 0.5 && printf L >> ../../counter.txt && printf lib > out.txt' },",
        "      cache: { inputs: { files: ['src.txt'] }, outputs: { files: ['out.txt'] } },",
        '    },',
        '  },',
        '}',
        '',
      ],
    ],
    [
      'app',
      [
        'export default {',
        '  tasks: {',
        '    build: {',
        "      exec: { command: 'printf A >> ../../counter.txt && printf app > out.txt' },",
        "      dependsOn: ['lib#build'],",
        "      cache: { inputs: { files: ['src.txt'], tasks: [] }, outputs: { files: ['out.txt'] } },",
        '    },',
        '  },',
        '}',
        '',
      ],
    ],
  ]
  for (const [name, body] of pkgs) {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        ...(name === 'app' ? { dependencies: { lib: '*' } } : {}),
      }),
    )
    await writeFile(path.join(dir, 'src.txt'), name)
    await writeFile(path.join(dir, 'vx.config.mjs'), body.join('\n'))
  }
  gitInitCommit(root)
  return root
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

  it('a restore-tier task skips dedup — its live upstream has a hole', async () => {
    // A confirmed local hit runs BEFORE its dependencies (restore tier), so
    // the `upstream` it is handed is incomplete. The dedup path would
    // recompute the task's hash from that array, and the fold reads every
    // entry: one `undefined` and the run dies with an internal error rather
    // than restoring bytes it already has. `admitTasks` routes a restorable
    // node straight to executeTask, which reuses the up-front probe instead.
    // Reachable only where both halves meet — a shared registry AND a
    // restore-tier node — which is why neither row above sees it: they run
    // cold, so nothing is ever in the restore tier.
    const root = await makeCrossProject()
    try {
      const warm = await run({ cwd: root, tasks: ['build'], log: silent })
      expect(warm.ok).toBe(true)
      // Evict `lib#build` alone. `app#build` folds no upstream key, so it
      // stays warm and becomes the restore-tier node with a running dep.
      await writeFile(path.join(root, 'packages', 'lib', 'src.txt'), 'lib2')

      const inflight = new Map<string, Promise<void>>()
      const opts: RunOptions = { cwd: root, tasks: ['build'], log: silent, inflight }
      const [a, b] = await Promise.all([run(opts), run(opts)])
      expect(a.ok).toBe(true)
      expect(b.ok).toBe(true)
      // Both runs restored `app#build` from the artifact the warm run saved.
      expect(
        [...a.outcomes, ...b.outcomes]
          .filter((o) => o.node.id === 'app#build')
          .map((o) => o.status),
      ).toEqual(['cache-hit', 'cache-hit'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

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
