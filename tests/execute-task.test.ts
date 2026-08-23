// Per-task execution lifecycle — `src/orchestrator/execute-task.ts`.
//
// This is the file every task passes through: probe → (hit: restore) /
// (miss: clean outputs → spawn → save), the retry loop, the `--verify`
// block, and outcome classification. A wrong decision here does not
// throw — it replays a stale artifact under a green `up-to-date`, or
// deletes a build tree the user is still debugging. Eight separate
// stale-hit defects in the decision log route through this file.
//
// Scope: what the neighbouring suites do NOT already pin. `retries.test.ts`
// owns the retry COUNTING (`attempts`, `--retry` precedence, key stability);
// `verify.test.ts` owns the verdict taxonomy; `local-shortcircuit.test.ts`
// owns the up-front CLASSIFY; `orchestrator.test.ts` owns the policy matrix
// at run level. This file owns the per-task mechanics those leave open:
// WHEN outputs are wiped, what survives a retry, how an abort differs from
// a timeout, what a `preProbed` entry is allowed to skip, and how a hit is
// classified.

import { readdirSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { Cache, type CacheEntry } from '../src/cache/index.js'
import { localExecutor } from '../src/plugins/local-executor/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { executeTask, restoreHit } from '../src/orchestrator/execute-task.js'

const TIMEOUT = 30_000

const NO_CACHE = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
const READ_ONLY = { localRead: true, localWrite: false, remoteRead: false, remoteWrite: false }

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

/** `git init` is not optional: vx defers to git for the input file set and
 *  raises a UserError outside a work tree. */
function initGit(cwd: string): void {
  const g = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  }
  g('init', '-q')
  g('config', 'user.email', 'test@vx.local')
  g('config', 'user.name', 'vx test')
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-exec-task-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'packages'), { recursive: true })
  initGit(root)
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

const lsSorted = (dir: string): string[] => readdirSync(dir).sort()

// ---------------------------------------------------------------------------
// Direct-drive scaffolding. `executeTask` / `restoreHit` are the exported
// entry points; driving them against a REAL `Cache` reaches contracts a run()
// cannot (a third-party layer's entry shape, a hand-supplied `preProbed`)
// without stubbing away the behaviour under test.
// ---------------------------------------------------------------------------

interface Bench {
  root: string
  dir: string
  cache: Cache
}

async function bench(): Promise<Bench> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-exec-unit-'))
  const dir = path.join(root, 'proj')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'proj' }))
  initGit(root)
  return { root, dir, cache: new Cache(path.join(root, '.vx', 'cache')) }
}

async function closeBench(b: Bench): Promise<void> {
  b.cache.close()
  await rm(b.root, { recursive: true, force: true })
}

function node(b: Bench, config: TaskNode['config'], id = 'proj#build'): TaskNode {
  return {
    id,
    projectName: 'proj',
    projectDir: b.dir,
    taskName: id.split('#')[1]!,
    config,
    deps: [],
    requested: true,
  }
}

function baseArgs(b: Bench, n: TaskNode, log: Logger) {
  return {
    node: n,
    upstream: [] as TaskOutcome[],
    workspaceRoot: b.root,
    workspaceFingerprint: 'fixture-fingerprint',
    cache: b.cache,
    log,
    executors: [localExecutor()],
    nestedProjectDirs: [] as string[],
    runStartHrTimeNs: process.hrtime.bigint(),
  }
}

/** A completed upstream, as the scheduler hands it to a group task. */
const upstreamOutcome = (id: string, hash: string): TaskOutcome =>
  ({ node: { id }, status: 'success', exitCode: 0, durationMs: 1, hash }) as unknown as TaskOutcome

// ===========================================================================

describe('execute-task — the pre-exec output wipe is gated on WRITES, not reads', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a read-only policy (local:r) executes a miss without wiping the output tree',
    async () => {
      // `willWrite` — not `willRead` — gates `cleanOutputs`, and the two axes
      // are independent. Under `local:r` nothing will be saved, so wiping the
      // tree would destroy files for a run that stores nothing to put back:
      // the `--no-cache` "leave the user's tree alone" contract, applied to
      // every policy whose write axes are off. A `--force` run (reads off,
      // writes ON) still wipes — that asymmetry is the point, and
      // orchestrator.test.ts pins its half.
      const dir = await addProject(
        fixture.root,
        'ro',
        `export default { tasks: { t: {
          exec: { command: 'mkdir -p dist && echo made > dist/made.txt' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
        } } }`,
      )
      await mkdir(path.join(dir, 'dist'), { recursive: true })
      await writeFile(path.join(dir, 'dist', 'stray.txt'), 'STRAY')

      const r = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['ro'],
        cache: READ_ONLY,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.status).toBe('success')
      // The stray is untouched AND the task's own output landed beside it.
      expect(lsSorted(path.join(dir, 'dist'))).toEqual(['made.txt', 'stray.txt'])
      expect(await readFile(path.join(dir, 'dist', 'stray.txt'), 'utf8')).toBe('STRAY')
    },
    TIMEOUT,
  )
})

describe('execute-task — output cleaning across retry attempts', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  // The command writes `dist/partial.txt` and fails on attempt 1, then writes
  // `dist/final.txt` and succeeds on attempt 2. `m` (outside the declared
  // outputs, so the wipe cannot reach it) is the attempt marker.
  const FLAKY_BUILD = `export default { tasks: { t: {
    exec: {
      command: 'mkdir -p dist; if test -f m; then echo final > dist/final.txt; else touch m; echo partial > dist/partial.txt; exit 1; fi',
      retries: 1,
    },
    cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
  } } }`

  it(
    "a failed attempt's partial outputs never leak into the next attempt or the cache",
    async () => {
      // `cleanOutputs` runs inside `runAttempt`, i.e. before EVERY attempt —
      // not once before the loop. Hoisting it out of the retry body is the
      // tempting simplification and it is silently wrong: the winning attempt
      // would be saved on top of a dead attempt's debris, so every later cache
      // hit would restore a file no successful run ever produced.
      const dir = await addProject(fixture.root, 'flaky', FLAKY_BUILD)

      const r = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['flaky'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.attempts).toBe(2)
      expect(lsSorted(path.join(dir, 'dist'))).toEqual(['final.txt'])

      // The saved ARTIFACT must agree with disk — a run that only cleaned the
      // working tree, or that resolved outputs before the last attempt, would
      // still ship partial.txt to every consumer of this cache entry.
      await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      await rm(path.join(dir, 'm'), { force: true })
      const warm = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['flaky'],
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(warm.outcomes[0]!.status).toBe('cache-hit')
      expect(lsSorted(path.join(dir, 'dist'))).toEqual(['final.txt'])
    },
    TIMEOUT,
  )

  it(
    '--no-cache leaves the tree alone BETWEEN attempts too (the debugging contract)',
    async () => {
      // The control for the test above, and the reason the clean is gated
      // rather than unconditional: with every axis off, the user is debugging
      // and owns their files. Both attempts' artefacts survive, including the
      // failed attempt's — which is exactly what someone stepping through a
      // flaky build wants to inspect.
      const dir = await addProject(fixture.root, 'nc', FLAKY_BUILD)

      const r = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['nc'],
        cache: NO_CACHE,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.attempts).toBe(2)
      expect(lsSorted(path.join(dir, 'dist'))).toEqual(['final.txt', 'partial.txt'])
    },
    TIMEOUT,
  )
})

describe('execute-task — retry loop control flow: abort vs timeout', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a shutdown-signal kill aborts immediately and is NEVER retried',
    async () => {
      // A child killed by SIGINT/SIGTERM did not finish on its own terms: the
      // run is tearing down, so re-spawning it would fight the teardown and
      // could leave grandchildren behind after `run()` returns. The task
      // classifies `aborted` (not `failed`), which propagates to dependents
      // without being counted, shown, or cached.
      //
      // The task SIGTERMs its own shell, which is what an external `kill`, a
      // supervisor, or `docker stop` looks like from the runner's side.
      const dir = await addProject(
        fixture.root,
        'ab',
        `export default { tasks: { t: {
          exec: { command: 'echo x >> tries.txt; kill -TERM $$', retries: 3 },
        } } }`,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['ab'],
        log: capturingLogger(fixture),
      })
      const o = r.outcomes[0]!
      expect(o.status).toBe('aborted')
      expect(o.exitCode).toBe(143)
      // ONE attempt despite `retries: 3` — the abort short-circuits the loop.
      expect((await readFile(path.join(dir, 'tries.txt'), 'utf8')).trim().split('\n')).toHaveLength(
        1,
      )
      // `attempts` is only set above 1, so a single-attempt abort omits it.
      expect(o.attempts).toBeUndefined()
      expect(r.ok).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'an aborted task is never cached — its partial outputs are not replayed next run',
    async () => {
      // The abort path returns BEFORE the save block, so the tree it left
      // half-written never becomes an entry. Getting this wrong is the
      // worst-shaped defect in the file: a mid-write kill would be sealed
      // into the cache under exactly the key a healthy run derives.
      const dir = await addProject(
        fixture.root,
        'abc',
        `export default { tasks: { t: {
          exec: { command: 'echo x >> tries.txt; mkdir -p dist; echo partial > dist/p.txt; kill -TERM $$' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
        } } }`,
      )
      const first = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['abc'],
        log: capturingLogger(fixture),
      })
      expect(first.outcomes[0]!.status).toBe('aborted')

      const second = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['abc'],
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      // Re-executed, NOT served from cache: two recorded attempts on disk.
      expect(second.outcomes[0]!.status).toBe('aborted')
      expect((await readFile(path.join(dir, 'tries.txt'), 'utf8')).trim().split('\n')).toHaveLength(
        2,
      )
    },
    TIMEOUT,
  )

  it(
    'a TIMEOUT kill is a real failure and IS retried (the signal is the same, the meaning is not)',
    async () => {
      // Both paths end in a SIGTERMed child, so the classifier cannot key on
      // the signal alone — `result.timedOut` is what separates "we set this
      // deadline" from "the run is shutting down". Drop that guard and every
      // timeout silently becomes `aborted`: unretried, uncounted, and absent
      // from the summary, so a hung build reports as if it never ran.
      const dir = await addProject(
        fixture.root,
        'to',
        `export default { tasks: { t: {
          exec: { command: 'echo x >> tries.txt; exec sleep 5', timeout: 300, retries: 1 },
        } } }`,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['to'],
        log: capturingLogger(fixture),
      })
      const o = r.outcomes[0]!
      expect(o.status).toBe('failed')
      expect(o.exitCode).toBe(143)
      expect(o.attempts).toBe(2)
      expect((await readFile(path.join(dir, 'tries.txt'), 'utf8')).trim().split('\n')).toHaveLength(
        2,
      )
      // The timeout says so on stderr — a bare 143 is otherwise unreadable.
      expect(fixture.err.join('')).toContain('timed out after 300ms')
    },
    TIMEOUT,
  )
})

describe('execute-task — cache-hit materialization', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    '`restored` distinguishes a materialized restore from an already-current tree',
    async () => {
      // `restored` is what the framed block turns into "up-to-date" vs
      // "local-cache", so it must mean "we wrote files this run", not "we had
      // a hit". The skip-restore short-circuit is the whole reason the two
      // differ: an untouched tree that still matches the entry's recorded
      // (size, mode, mtime) is left alone entirely.
      const dir = await addProject(
        fixture.root,
        's',
        `export default { tasks: { t: {
          exec: { command: 'mkdir -p dist && echo v1 > dist/o.txt' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
        } } }`,
      )
      await run({ cwd: fixture.root, tasks: ['t'], projects: ['s'], log: capturingLogger(fixture) })

      const untouched = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['s'],
        log: capturingLogger(fixture),
      })
      expect(untouched.outcomes[0]!.status).toBe('cache-hit')
      expect(untouched.outcomes[0]!.restored).toBe(false)

      await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      const wiped = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['s'],
        log: capturingLogger(fixture),
      })
      expect(wiped.outcomes[0]!.status).toBe('cache-hit')
      expect(wiped.outcomes[0]!.restored).toBe(true)
      expect(await readFile(path.join(dir, 'dist', 'o.txt'), 'utf8')).toBe('v1\n')
    },
    TIMEOUT,
  )

  it(
    'a task declaring NO outputs is vacuously up-to-date (never reports a restore)',
    async () => {
      // A `lint`-shaped cacheable task materializes nothing, so claiming
      // `restored: true` would put "local-cache" on a row where not one byte
      // moved. The `&& anyOutputs` conjunct is what keeps that honest; the
      // skip-restore branch above cannot cover it, because with no declared
      // outputs there is no fingerprint to compare and `skipRestore` stays
      // false on every hit.
      await addProject(
        fixture.root,
        'lintish',
        `export default { tasks: { t: {
          exec: { command: 'echo linted' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
        } } }`,
      )
      await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['lintish'],
        log: capturingLogger(fixture),
      })
      const warm = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['lintish'],
        log: capturingLogger(fixture),
      })
      expect(warm.outcomes[0]!.status).toBe('cache-hit')
      expect(warm.outcomes[0]!.restored).toBe(false)
    },
    TIMEOUT,
  )
})

describe('execute-task — restoreHit classification (entry shapes a run() cannot produce)', () => {
  let b: Bench
  beforeEach(async () => {
    b = await bench()
  })
  afterEach(async () => {
    await closeBench(b)
  })

  const NO_OUTPUT_TASK = {
    exec: { command: 'echo should-not-run' },
    cache: { inputs: { files: [] }, outputs: { files: [] } },
  }

  /** Save a real artifact so `restoreOutputs` has bytes to extract, then hand
   *  `restoreHit` the entry a layer would return for it. */
  async function seedEntry(hash: string, stdout: string): Promise<CacheEntry> {
    await b.cache.save({
      hash,
      projectDir: b.dir,
      outputFiles: [],
      entry: { taskId: 'proj#build', command: 'x', durationMs: 4321, stdout },
    })
    const hit = await b.cache.get(hash)
    if (hit === null) throw new Error('fixture: seeded entry did not read back')
    return hit
  }

  it('a remote-sourced entry reports cache-hit-remote', async () => {
    // Provenance is the "did the remote actually save me work?" signal, and
    // it is carried by the ENTRY, not by which layer object answered — a
    // LayeredCache stamps `source: 'remote'` on a hit it had to pull even
    // though the artifact is local by the time it is read back.
    const hit = await seedEntry('aaaabbbbccccdddd', '')
    const o = await restoreHit({
      args: baseArgs(b, node(b, NO_OUTPUT_TASK), capturingLogger({ root: '', out: [], err: [] })),
      hash: 'aaaabbbbccccdddd',
      hit: { ...hit, source: 'remote' },
      cacheOpStart: performance.now(),
      taskStartNs: 0n,
    })
    expect(o.status).toBe('cache-hit-remote')
    expect(o.exitCode).toBe(0)

    const local = await restoreHit({
      args: baseArgs(b, node(b, NO_OUTPUT_TASK), capturingLogger({ root: '', out: [], err: [] })),
      hash: 'aaaabbbbccccdddd',
      hit: { ...hit, source: 'local' },
      cacheOpStart: performance.now(),
      taskStartNs: 0n,
    })
    expect(local.status).toBe('cache-hit')
  })

  it('an entry recording a non-zero exit restores as FAILED, never a green hit', async () => {
    // Defence in DEPTH now, where it used to be defence in theory. The save
    // contract no longer accepts an `exitCode` (`Omit<CacheEntry, … |
    // 'exitCode'>`) and `IngestMeta` never did, so neither path can write a
    // non-zero one: "vx caches only successes" went from a rule every call site
    // had to remember to a shape the type will not let you express.
    //
    // The branch stays, and stays tested, because the column outlives this
    // process — a hand-edited cache.db, or one written by a different vx build
    // sharing the directory, can hold a non-zero value, and a third-party
    // `CacheLayer` can return one directly, which is the shape driven here.
    // Without the check such an entry reads as `cache-hit` and a broken build's
    // outputs are restored over a good tree under a green run.
    const hit = await seedEntry('bbbbccccddddeeee', '')
    expect(hit.exitCode).toBe(0)

    const o = await restoreHit({
      args: baseArgs(b, node(b, NO_OUTPUT_TASK), capturingLogger({ root: '', out: [], err: [] })),
      hash: 'bbbbccccddddeeee',
      hit: { ...hit, exitCode: 3, source: 'remote' },
      cacheOpStart: performance.now(),
      taskStartNs: 0n,
    })
    // `failed` wins over the source ternary: a poisoned entry must not be
    // laundered into `cache-hit-remote` and reported green.
    expect(o.status).toBe('failed')
    expect(o.exitCode).toBe(3)
  })

  it('replays the entry stdout and reports the SKIPPED exec time apart from the restore cost', async () => {
    // `durationMs` is what THIS run spent (probe + restore); `storedDurationMs`
    // is what the hit skipped. Collapsing them is how `--report`'s headline
    // once reported "4ms saved" for a task that takes seconds. 4321ms is far
    // enough from any real restore that the two cannot be confused.
    const hit = await seedEntry('ddddeeeeffff0000', 'REPLAYED-STDOUT')
    const f: Fixture = { root: b.root, out: [], err: [] }
    const o = await restoreHit({
      args: baseArgs(b, node(b, NO_OUTPUT_TASK), capturingLogger(f)),
      hash: 'ddddeeeeffff0000',
      hit,
      cacheOpStart: performance.now(),
      taskStartNs: 0n,
    })
    expect(f.out.join('')).toBe('REPLAYED-STDOUT')
    expect(o.storedDurationMs).toBe(4321)
    expect(o.durationMs).toBeLessThan(4321)
  })
})

describe('execute-task — preProbed reuse (the two-tier scheduler contract)', () => {
  let b: Bench
  beforeEach(async () => {
    b = await bench()
  })
  afterEach(async () => {
    await closeBench(b)
  })

  const CACHEABLE = {
    exec: { command: 'echo executed > out.txt' },
    cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
  }

  it('a preProbed HIT is restored with no second probe', async () => {
    // The classify phase already paid for the `cache.get`. Probing again would
    // double every warm run's cache reads, and — because a restore-tier task
    // may run BEFORE its dependencies finish — a second probe would be issued
    // against an upstream set that is deliberately incomplete.
    await writeFile(path.join(b.dir, 'out.txt'), 'CACHED')
    await b.cache.save({
      hash: 'feedfacefeedface',
      projectDir: b.dir,
      outputFiles: [path.join(b.dir, 'out.txt')],
      entry: { taskId: 'proj#build', command: 'x', durationMs: 999, stdout: 'HI' },
    })
    const hit = await b.cache.get('feedfacefeedface')
    await rm(path.join(b.dir, 'out.txt'), { force: true })

    const getSpy = spyOn(b.cache, 'get')
    const o = await executeTask({
      ...baseArgs(b, node(b, CACHEABLE), capturingLogger({ root: '', out: [], err: [] })),
      preProbed: { hash: 'feedfacefeedface', hit: hit! },
    })
    expect(getSpy).toHaveBeenCalledTimes(0)
    expect(o.status).toBe('cache-hit')
    expect(o.hash).toBe('feedfacefeedface')
    // The command would have written "executed"; the restore wins.
    expect(await readFile(path.join(b.dir, 'out.txt'), 'utf8')).toBe('CACHED')
    getSpy.mockRestore()
  })

  it('a preProbed MISS skips the probe and saves under the up-front hash VERBATIM', async () => {
    // The up-front key is authoritative for a classified task: it was derived
    // from a provably stable input set. Recomputing it here would re-derive
    // against the live (possibly incomplete) upstream, so the entry would be
    // written under a key no later run reproduces — a cache that always misses
    // and grows forever. The hash below is deliberately not derivable from
    // this fixture, so only verbatim reuse can produce it.
    const getSpy = spyOn(b.cache, 'get')
    const o = await executeTask({
      ...baseArgs(b, node(b, CACHEABLE), capturingLogger({ root: '', out: [], err: [] })),
      preProbed: { hash: 'deadbeefdeadbeef', hit: null },
    })
    expect(getSpy).toHaveBeenCalledTimes(0)
    expect(o.status).toBe('success')
    expect(o.hash).toBe('deadbeefdeadbeef')
    // The save landed under that exact key — `output_files` rows exist for it.
    const rows = b.cache.loadOutputFilesBatch(['deadbeefdeadbeef']).get('deadbeefdeadbeef')
    expect(rows?.map((r) => r.path)).toEqual(['out.txt'])
    getSpy.mockRestore()
  })

  it('a task with NO preProbed entry derives its own hash and probes exactly once', async () => {
    // The control. Without it the two tests above would still pass if
    // `preProbed` were ignored in one direction — this pins that the lazy path
    // is genuinely the other branch, not the same code with a different label.
    const getSpy = spyOn(b.cache, 'get')
    const o = await executeTask({
      ...baseArgs(b, node(b, CACHEABLE), capturingLogger({ root: '', out: [], err: [] })),
    })
    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(o.status).toBe('success')
    expect(o.hash).not.toBe('deadbeefdeadbeef')
    expect(o.hash).toMatch(/^[0-9a-f]{16}$/)
    getSpy.mockRestore()
  })
})

describe('execute-task — the --verify side-channel', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    "the verify re-run's CONTENT never survives — disk ends byte-identical to the cached artifact",
    async () => {
      // `verify.test.ts` pins the diverging-FILENAME case (a stray the restore
      // would never overwrite). This is the ordinary case: same filename,
      // different bytes. The re-run overwrites the saved output in place, so
      // without the post-verdict restore the tree silently keeps attempt 2's
      // bytes while the cache holds attempt 1's — and the very next hit would
      // "up-to-date" its way past a tree that never matched the entry.
      const dir = await addProject(
        fixture.root,
        'v',
        `export default { tasks: { t: {
          exec: { command: 'if test -f m; then echo SECOND > out.txt; else touch m; echo FIRST > out.txt; fi' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['v'],
        // Allowed, so the run stays green and the assertion is about the TREE,
        // not about the verdict (which verify.test.ts owns).
        verify: { determinism: true, inputs: false, fingerprint: false, allow: new Set(['v#t']) },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify?.kind).toBe('allowed-nondeterministic')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('FIRST\n')
    },
    TIMEOUT,
  )

  it(
    'a NON-cacheable task carries no verdict and no fingerprint under --verify',
    async () => {
      // Every verify path is gated on `willWrite`. A task with no `cache` block
      // saved nothing, so there is no artifact to restore and nothing whose
      // reproducibility could matter — ungating the determinism block would
      // send it into `cache.restoreOutputs` for a hash that was never written
      // and fail a task that succeeded.
      await addProject(
        fixture.root,
        'nc',
        `export default { tasks: { t: { exec: { command: 'echo hi > out.txt' } } } }`,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['t'],
        projects: ['nc'],
        verify: { determinism: true, inputs: false, fingerprint: true, allow: new Set<string>() },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.status).toBe('success')
      expect(r.outcomes[0]!.verify).toBeUndefined()
      expect(r.outcomes[0]!.outputFp).toBeUndefined()
    },
    TIMEOUT,
  )
})

describe('execute-task — dispatch: group and persistent paths', () => {
  it('a group never touches the cache, costs nothing, and cascades its upstreams', async () => {
    // A group has no `exec`, so it must not reach the cached path at all: the
    // config loader refuses `cache` on a group, so a `cache.get` there would
    // probe a key derived from a task that cannot produce outputs. Its hash
    // exists only so downstream keys keep cascading THROUGH it, which means it
    // has to move with the upstream set and NOT with the order the scheduler
    // happened to finish them in (completion order varies run to run).
    const b = await bench()
    try {
      const g = node(b, { dependsOn: ['lint'] }, 'proj#ci')
      const getSpy = spyOn(b.cache, 'get')
      const saveSpy = spyOn(b.cache, 'save')
      const log = capturingLogger({ root: '', out: [], err: [] })
      const drive = (upstream: TaskOutcome[]) => executeTask({ ...baseArgs(b, g, log), upstream })

      const one = await drive([upstreamOutcome('proj#lint', 'aaaaaaaaaaaaaaaa')])
      const other = await drive([upstreamOutcome('proj#lint', 'bbbbbbbbbbbbbbbb')])
      const pair = await drive([
        upstreamOutcome('proj#t2', 'zzzzzzzzzzzzzzzz'),
        upstreamOutcome('proj#lint', 'aaaaaaaaaaaaaaaa'),
      ])
      const pairFlipped = await drive([
        upstreamOutcome('proj#lint', 'aaaaaaaaaaaaaaaa'),
        upstreamOutcome('proj#t2', 'zzzzzzzzzzzzzzzz'),
      ])

      expect(one.status).toBe('success')
      expect(one.exitCode).toBe(0)
      // No process ran, so no time may be attributed to it — the summary's
      // task/cache meters partition on exactly this.
      expect(one.durationMs).toBe(0)
      expect(one.hash).toMatch(/^[0-9a-f]{16}$/)
      expect(one.hash).not.toBe(other.hash)
      expect(pair.hash).toBe(pairFlipped.hash)
      expect(getSpy).toHaveBeenCalledTimes(0)
      expect(saveSpy).toHaveBeenCalledTimes(0)
      getSpy.mockRestore()
      saveSpy.mockRestore()
    } finally {
      await closeBench(b)
    }
  })

  it(
    'a persistent task derives NO hash (it can never be cached)',
    async () => {
      // The absence is load-bearing, not incidental: `!o.hash` is what the
      // recording layer uses to select exactly {skipped, persistent}, and a
      // dev server that acquired a hash would become a cache entry replaying
      // a long-dead process's stdout.
      const f = await makeWorkspace()
      try {
        await addProject(
          f.root,
          'srv',
          `export default { tasks: { dev: {
            exec: { command: 'echo ready; exec sleep 30', persistent: { readyWhen: 'ready' } },
          } } }`,
        )
        const r = await run({
          cwd: f.root,
          tasks: ['dev'],
          projects: ['srv'],
          log: capturingLogger(f),
        })
        expect(r.outcomes[0]!.status).toBe('success')
        expect(r.outcomes[0]!.hash).toBeUndefined()
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
