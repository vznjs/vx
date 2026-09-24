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
import { addProject, gitInit, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { Cache, GitFilesCache, type CacheEntry } from '../src/cache/index.js'
import { localExecutor } from '../src/exec/local-executor.js'
import { UserError } from '../src/util/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { ExecuteRequest, TaskExecutor } from '../src/exec/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { executeTask, restoreHit } from '../src/orchestrator/execute-task.js'

const TIMEOUT = 30_000

const NO_CACHE = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false }
const READ_ONLY = { localRead: true, localWrite: false, remoteRead: false, remoteWrite: false }
/** `--force`: reads off, writes ON — the half of the asymmetry below. */
const FORCE = { localRead: false, localWrite: true, remoteRead: false, remoteWrite: false }

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
async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-exec-task-' })
  return { root, out: [], err: [] }
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
  gitInit(root)
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
    executor: localExecutor(),
    nestedProjectDirs: [] as string[],
    runStartHrTimeNs: process.hrtime.bigint(),
    keyedProjects: () => new Set<string>(),
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
      // writes ON) still wipes — that asymmetry is the point, and the row
      // below pins its half. (It used to point at `orchestrator.test.ts`,
      // which pins the wipe under the DEFAULT policy — the write axis on
      // AND the read axis on, so it proves nothing about the asymmetry;
      // 2026-09-20.)
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

  it(
    'the other half: --force (reads OFF, writes on) wipes and repopulates',
    async () => {
      // The asymmetry the row above names. `willWrite` gates the clean, so
      // a policy with reads off and writes on must still wipe — the run
      // stores what it produces, so a leftover would be packed into the
      // artifact and replayed forever. Nothing pinned this half: the
      // wipe test next door runs the DEFAULT policy, where both axes are
      // on (2026-09-20).
      const dir = await addProject(
        fixture.root,
        'forced',
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
        projects: ['forced'],
        cache: FORCE,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.status).toBe('success')
      // Wiped AND repopulated: the task's own output, and nothing else.
      expect(lsSorted(path.join(dir, 'dist'))).toEqual(['made.txt'])
    },
    TIMEOUT,
  )
})

describe('execute-task — the READ half of the same asymmetry', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    '--force re-executes against a WARM cache instead of restoring it',
    async () => {
      // `willRead` keys on the READ axes, exactly as `willWrite` keys on
      // the write ones — and the row next door pins only the write half.
      // The `--force` fixture there builds a fresh project with NO prior
      // entry, so whether a probe happens is invisible to it: swap
      // `willRead` onto the write axes and `--force` probes, hits, and
      // restores, serving cached bytes at the one moment the user asked
      // for a rebuild. The task counts its own executions on disk.
      const dir = await addProject(
        fixture.root,
        'warm',
        `export default { tasks: { t: {
          exec: { command: 'mkdir -p dist && echo x >> runs.txt && echo made > dist/made.txt' },
          cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
        } } }`,
      )
      const once = { cwd: fixture.root, tasks: ['t'], projects: ['warm'] }
      // Populate the cache with the default (all-axes) policy.
      const first = await run({ ...once, log: capturingLogger(fixture) })
      expect(first.outcomes[0]!.status).toBe('success')

      // CONTROL: a read-enabled policy DOES hit this warm entry, so the
      // row below is measuring the policy and not a cold cache.
      const hit = await run({ ...once, cache: READ_ONLY, log: capturingLogger(fixture) })
      expect(hit.outcomes[0]!.status).toBe('cache-hit')

      const forced = await run({ ...once, cache: FORCE, log: capturingLogger(fixture) })
      expect(forced.outcomes[0]!.status).toBe('success')
      // Two executions: the populate and the forced one. The cache hit in
      // between ran nothing.
      const lines = (await readFile(path.join(dir, 'runs.txt'), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
    },
    TIMEOUT,
  )
})

describe("execute-task — exec.remote:'only' with no remote executor", () => {
  it('succeeds without running, and still carries the hash dependents fold', async () => {
    // The local no-op half. `placement.test.ts` is the only other file
    // that names `remoteOnlyNoop`, and it uses it as an EMPTY Set in a
    // helper — nothing ever drove executeTask with the flag set, so the
    // branch could return `failed`, or drop the hash, with the suite
    // green. The hash is the part that matters: it is computed precisely
    // so dependents fold it, and dropping it moves every dependent's key.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      let ran = 0
      const never = {
        name: 'org/never',
        execute: async () => {
          ran++
          return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
        },
      } as never
      const n = node(b, {
        exec: { command: 'echo should-not-run' },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
      })
      const o = await executeTask({
        ...baseArgs(b, n, log),
        executor: never,
        remoteOnlyNoop: true,
      })
      expect([o.status, o.exitCode]).toEqual(['success', 0])
      expect(ran).toBe(0)
      expect(typeof o.hash).toBe('string')
      expect(o.hash!.length).toBeGreaterThan(0)
    } finally {
      await closeBench(b)
    }
  })
})

describe('execute-task — what the outcome and the request carry', () => {
  it('captures stdout only when it will be SAVED, and never stderr', async () => {
    // "cache.save is the single consumer of result.stdout, and it runs
    // only when this task will WRITE an entry; result.stderr has no
    // consumer at all." Both streams still reach the logger live; only
    // the retained copy is dropped, which for a chatty task is its full
    // byte size in heap. That is a COST, invisible in any outcome — so
    // the executor itself records what it was asked to capture.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      const seen: Array<{ stdout: boolean | undefined; stderr: boolean | undefined }> = []
      const recorder = {
        name: 'org/recorder',
        execute: async (req: ExecuteRequest) => {
          seen.push({ stdout: req.capture.stdout, stderr: req.capture.stderr })
          return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
        },
      } as never
      const cached = node(b, {
        exec: { command: 'true' },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
      })
      await executeTask({ ...baseArgs(b, cached, log), executor: recorder })
      // A task that will not write an entry retains nothing.
      await executeTask({
        ...baseArgs(b, cached, log),
        executor: recorder,
        cachePolicy: NO_CACHE,
      })
      expect(seen).toEqual([
        { stdout: true, stderr: false },
        { stdout: false, stderr: false },
      ])
    } finally {
      await closeBench(b)
    }
  })

  it('reports the sandbox violation COUNT and lines on the outcome', async () => {
    // The rewrite of a zero exit to 1 is pinned next door, but what the
    // outcome then TELLS the reader was not: the count feeds the
    // footer's sandbox column and the lines are the only record of which
    // grant was missing.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      const n = node(b, { exec: { command: 'true', sandbox: {} } }, 'proj#sb')
      const denied = {
        name: 'org/denied',
        execute: async () => ({
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
          violations: [
            { timestamp: new Date(), line: 'deny file-read-data /etc/hosts' },
            { timestamp: new Date(), line: 'deny network-outbound' },
          ],
        }),
      } as never
      const o = await executeTask({ ...baseArgs(b, n, log), executor: denied })
      expect(o.status).toBe('failed')
      expect(o.sandboxViolations).toBe(2)
      expect(o.sandboxViolationLines).toEqual([
        'deny file-read-data /etc/hosts',
        'deny network-outbound',
      ])
    } finally {
      await closeBench(b)
    }
  })

  it('stamps the wallclock window start-before-end', async () => {
    // The run-detail timeline reads these as a span. Swapped, every task
    // renders a negative window — and the pair is only ever read
    // together, so neither half alone says which is which.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      const n = node(b, { exec: { command: 'true' } })
      const o = await executeTask({ ...baseArgs(b, n, log), executor: localExecutor() })
      expect(o.wallclockStartNs).toBeDefined()
      expect(o.wallclockEndNs).toBeDefined()
      expect(o.wallclockEndNs!).toBeGreaterThan(o.wallclockStartNs!)
    } finally {
      await closeBench(b)
    }
  })

  it('an UNUSED write grant is not a violation on a successful exit', async () => {
    // A literal write grant that names nothing on disk is bound as an
    // empty file, and swept again if the task never wrote it. On a
    // FAILING task that sweep is the one clue to a grant that meant a
    // directory, so its line is attached — but on a task that exited 0
    // it is not a denial at all. Reported anyway, it becomes a violation,
    // and `userSandbox && violations > 0 && code === 0` rewrites the exit:
    // a passing sandboxed task fails for not writing somewhere it was
    // merely allowed to.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      const n = node(
        b,
        { exec: { command: 'true', sandbox: { allow: { write: ['unused.txt'] } } } },
        'proj#grant',
      )
      const clean = {
        name: 'org/clean',
        execute: async () => ({
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
          violations: [],
        }),
      } as never
      const o = await executeTask({ ...baseArgs(b, n, log), executor: clean })
      expect([o.status, o.exitCode]).toEqual(['success', 0])
      expect(o.sandboxViolations).toBeUndefined()
    } finally {
      await closeBench(b)
    }
  })

  it('a SIGKILLed child is a FAILURE, not an abort', async () => {
    // SIGINT/SIGTERM mean the run is tearing down, so the task never
    // finished on its own terms. SIGKILL is an OOM or a forced kill —
    // "stays a real failure" — and folding it in would hide every
    // out-of-memory task from the footer's failure count.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      const n = node(b, { exec: { command: 'true' } }, 'proj#oom')
      const killed = {
        name: 'org/killed',
        execute: async () => ({
          exitCode: 137,
          durationMs: 1,
          stdout: '',
          stderr: '',
          violations: [],
          signal: 'SIGKILL' as const,
        }),
      } as never
      const o = await executeTask({ ...baseArgs(b, n, log), executor: killed })
      expect(o.status).toBe('failed')
      // CONTROL: the same shape with SIGTERM IS an abort.
      const term = {
        name: 'org/term',
        execute: async () => ({
          exitCode: 143,
          durationMs: 1,
          stdout: '',
          stderr: '',
          violations: [],
          signal: 'SIGTERM' as const,
        }),
      } as never
      const t = await executeTask({ ...baseArgs(b, n, log), executor: term })
      expect(t.status).toBe('aborted')
    } finally {
      await closeBench(b)
    }
  })

  it('says nothing about empty inputs when the task DECLARED none', async () => {
    // The warning names the globs that matched nothing, so a task with no
    // `cache.inputs` at all has nothing to name — it would print an empty
    // parenthesis on every miss of every uncached task in the run.
    const b = await bench()
    try {
      const said: string[] = []
      const log: Logger = {
        status(line) {
          said.push(line)
        },
        taskStdout() {},
        taskStderr() {},
        taskComplete() {},
      }
      // The task must be CACHEABLE with an empty declaration: a task with
      // no `cache` block at all resolves no inputs, so `inputs !== undefined`
      // answers first and the guard under test is never reached.
      const n = node(
        b,
        {
          exec: { command: 'true' },
          cache: { inputs: { files: [] }, outputs: { files: [] } },
        },
        'proj#bare',
      )
      await executeTask({ ...baseArgs(b, n, log), executor: localExecutor() })
      expect(said.filter((l) => l.includes('matched no files'))).toEqual([])

      // CONTROL: the same task that DOES declare a glob, matching nothing,
      // is exactly what the warning is for.
      const declared = node(
        b,
        {
          exec: { command: 'true' },
          cache: { inputs: { files: ['nowhere/**'] }, outputs: { files: [] } },
        },
        'proj#declared',
      )
      await executeTask({ ...baseArgs(b, declared, log), executor: localExecutor() })
      expect(said.filter((l) => l.includes('matched no files'))).toHaveLength(1)
    } finally {
      await closeBench(b)
    }
  })
})

describe('execute-task — what the clean and the fetch must NOT skip', () => {
  it('marks WORKSPACE outputs it wiped, exactly as it marks project ones', async () => {
    // Two calls, one rule: a wiped path must be marked so a stale git
    // snapshot cannot keep listing it with its committed OID — which
    // would hold a consumer's key unchanged while the file is gone from
    // disk. The project-dir call is caught by the suite; its
    // workspace-root twin, which can delete into OTHER projects' dirs,
    // was free.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      await mkdir(path.join(b.root, 'shared'), { recursive: true })
      await writeFile(path.join(b.root, 'shared', 'gen.txt'), 'stale')
      // A REAL GitFilesCache with one method spied: a hand-rolled stub
      // would enter by a different door than the product does (it also
      // needs `snapshotFor` on the hash path), and could drift from the
      // interface without the row noticing.
      const gitFilesCache = new GitFilesCache()
      const marked: Array<[string, readonly string[]]> = []
      const markSpy = spyOn(gitFilesCache, 'markWorkspaceOutputsChanged').mockImplementation(
        (rootDir: string, rels: readonly string[]) => {
          marked.push([rootDir, [...rels]])
        },
      )
      const n = node(b, {
        exec: { command: 'true' },
        cache: {
          inputs: { files: ['package.json'] },
          outputs: { files: [], workspaceFiles: ['shared/**'] },
        },
      })
      await executeTask({ ...baseArgs(b, n, log), executor: localExecutor(), gitFilesCache })
      markSpy.mockRestore()
      expect(marked).toHaveLength(1)
      expect(marked[0]![0]).toBe(b.root)
      expect([...marked[0]![1]]).toEqual(['shared/gen.txt'])
    } finally {
      await closeBench(b)
    }
  })

  it('does not fetch deferred producers for a REMOTE-placed task', async () => {
    // "A remote-placed task needs nothing: its worker grafts the upstream
    // bytes by reference." Materializing anyway drags every deferred
    // producer's outputs onto THIS machine — the whole cost the deferral
    // exists to avoid — and nothing held the guard.
    const b = await bench()
    try {
      const log = capturingLogger({ root: '', out: [], err: [] })
      let fetched = 0
      const deferred = {
        materializeFor: async () => {
          fetched++
        },
        register: () => {},
      } as never
      const remote = {
        name: 'org/remote',
        remote: true,
        execute: async () => ({
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
          violations: [],
        }),
      } as never
      const n = node(b, { exec: { command: 'true' } }, 'proj#far')
      await executeTask({ ...baseArgs(b, n, log), executor: remote, deferred })
      expect(fetched).toBe(0)

      // CONTROL: the same task on a LOCAL executor does fetch them.
      const local = {
        name: 'org/here',
        execute: async () => ({
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
          violations: [],
        }),
      } as never
      await executeTask({ ...baseArgs(b, n, log), executor: local, deferred })
      expect(fetched).toBe(1)
    } finally {
      await closeBench(b)
    }
  })
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
      // The timeout says so on stderr — a bare 143 is otherwise unreadable —
      // and the outcome carries it, so every label reads "timed out" where
      // it would otherwise read the signal (item 268).
      expect(fixture.err.join('')).toContain('timed out after 300ms')
      expect(o.timedOut).toBe(true)
      expect(fixture.err.join('')).toContain('retrying to#t (attempt 2/2) after a timeout')
    },
    TIMEOUT,
  )
})

describe('execute-task — what one attempt may hand the next', () => {
  it(
    'a violation belongs to the attempt that produced it, never to the retry',
    async () => {
      // `violations` is a closure variable the attempt loop reuses, kept
      // honest by TWO lines: the reset at the top of `runAttempt` and the
      // whole-array assignment after the executor returns. Either alone is
      // enough, so each masks the other and neither is held — drop both and
      // a first attempt's denial re-fails a clean retry, with the earlier
      // attempt's lines attached to an outcome that never tripped anything.
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const n = node(b, { exec: { command: 'true', sandbox: {}, retries: 1 } }, 'proj#retry')
        let attempts = 0
        const flaky = {
          name: 'org/flaky-sandbox',
          execute: async () => {
            attempts++
            return {
              exitCode: 0,
              durationMs: 1,
              stdout: '',
              stderr: '',
              violations:
                attempts === 1 ? [{ timestamp: new Date(), line: 'deny file-read-data /etc' }] : [],
            }
          },
        } as never
        const outcome = await executeTask({ ...baseArgs(b, n, log), executor: flaky })
        // The control: the first attempt really did fail on its violation —
        // a zero exit rewritten to 1 is the only reason a second one happened.
        expect(attempts).toBe(2)
        expect([outcome.status, outcome.exitCode]).toEqual(['success', 0])
        expect(outcome.sandboxViolationLines).toBeUndefined()
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  it(
    "a violation on a task that declared NO sandbox is not core's to act on",
    async () => {
      // Fail-on-violation is scoped to `userSandbox` — `exec.sandbox` in the
      // task config, the single source of truth for the contract. An executor
      // that sandboxes on its OWN terms and reports denials for a task that
      // asked for none does not get to fail it here: core never folded that
      // grant into the key and has no contract to enforce. Dropping the scope
      // is silent in-tree, because the local executor returns no violations
      // unless it sandboxed, so only a plugin can reach it.
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const n = node(b, { exec: { command: 'true' } }, 'proj#unsandboxed')
        const noisy = {
          name: 'org/own-sandbox',
          execute: async () => ({
            exitCode: 0,
            durationMs: 1,
            stdout: '',
            stderr: '',
            violations: [{ timestamp: new Date(), line: 'deny file-read-data /etc' }],
          }),
        } as never
        const outcome = await executeTask({ ...baseArgs(b, n, log), executor: noisy })
        expect([outcome.status, outcome.exitCode]).toEqual(['success', 0])
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  it(
    'a TRAPPED timeout keeps its timeout line and gains no contradicting verdict',
    async () => {
      // `signal-death > vx's own timeout keeps its line and gets no signal
      // verdict` asserts exactly this and cannot fail: its child is really
      // SIGTERMed, so the runner reports the signal and `signalVerdict`
      // declines a SIGINT/SIGTERM it was handed. Two copies of one rule, and
      // the e2e fixture only ever reaches the inner one.
      //
      // A child that TRAPS SIGTERM and exits 0 reaches the other: the runner
      // saw NO signal, execute-task rewrites the code to 143 itself, and
      // `shellVerdict` then reads 143 as "128 + 15 … something outside vx
      // asked the process to stop" — printed directly under the line saying
      // vx's own deadline killed it. The `!res.timedOut` gate is what keeps
      // the two from contradicting each other.
      const b = await bench()
      const f = { root: '', out: [] as string[], err: [] as string[] }
      try {
        const log = capturingLogger(f)
        const n = node(b, { exec: { command: 'true', timeout: 300 } }, 'proj#trap')
        const trapped = {
          name: 'org/trapped',
          execute: async () => ({
            exitCode: 0,
            durationMs: 1,
            stdout: '',
            stderr: '',
            violations: [],
            timedOut: true,
          }),
        } as never
        const outcome = await executeTask({ ...baseArgs(b, n, log), executor: trapped })
        const err = f.err.join('')
        expect([outcome.status, outcome.exitCode]).toEqual(['failed', 143])
        expect(err).toContain('[vx] timed out after 300ms')
        expect(err).not.toContain('is 128 +')
        expect(err).not.toContain('is how the shell reports')
      } finally {
        await closeBench(b)
      }
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

  it('a remote-WRITE-only policy still saves — willWrite reads both write axes', async () => {
    // `willWrite` is `(policy.localWrite || policy.remoteWrite)`: either
    // axis means this task will write an entry somewhere, so it cleans and
    // it saves. Reading only the LOCAL axis makes a remote-write-only run
    // silently save nothing at all — the run is green and the cache stays
    // empty, which is the quietest way for a remote cache to be useless.
    const REMOTE_WRITE_ONLY = {
      localRead: false,
      localWrite: false,
      remoteRead: false,
      remoteWrite: true,
    }
    const o = await executeTask({
      ...baseArgs(b, node(b, CACHEABLE), capturingLogger({ root: '', out: [], err: [] })),
      cachePolicy: REMOTE_WRITE_ONLY,
    } as never)
    expect(o.status).toBe('success')
    expect(b.cache.loadOutputFilesBatch([o.hash ?? '']).size).toBe(1)
  })

  it('the DEFERRED save site refuses a failure and a tainted run, exactly as the eager one does', async () => {
    // Two save sites share one pair of gates — `effectiveExitCode === 0 &&
    // willSave` — differing only on whether the outputs landed here. The
    // EAGER branch's gates are held by rows above; the DEFERRED branch's
    // were held by nothing, and it is the branch that hands a closure to a
    // later consumer to pull bytes with. Registering there on a failure
    // caches a failed task's outputs; registering on a tainted run caches
    // bytes built on a partial tree under the key a HEALTHY run derives,
    // which the args docblock calls "the next clean run's stale hit".
    //
    // A real remote executor produces the missing shape: it ran the
    // command, got a non-zero exit, and still holds output blobs in CAS.
    const registered: string[] = []
    const deferred = {
      register: (id: string) => {
        registered.push(id)
      },
      // execute-task also asks the registry to materialise a task's
      // upstream deferrals; a stub without it fails the run for that
      // reason instead of the gate under test.
      materializeFor: async () => undefined,
    }
    const far = (exitCode: number): TaskExecutor => ({
      name: 'far',
      async execute(req: ExecuteRequest) {
        // The declared output has to exist or the outcome fails for that
        // reason instead of the one under test — the deferred branch only
        // REGISTERS the closure, it never calls it.
        if (exitCode === 0) await writeFile(path.join(req.cwd, 'out.txt'), 'far\n')
        return {
          exitCode,
          durationMs: 1,
          stdout: '',
          stderr: '',
          violations: [],
          outputs: { kind: 'deferred' as const, materialize: async () => undefined },
        }
      },
    })
    // 1. A FAILURE down the deferred path registers nothing.
    const failed = await executeTask({
      ...baseArgs(b, node(b, CACHEABLE), capturingLogger({ root: '', out: [], err: [] })),
      executor: far(7),
      download: 'deferred' as const,
      deferred: deferred as never,
    } as never)
    expect([failed.status, registered]).toEqual(['failed', []])
    // 2. A TAINTED success down the same path registers nothing either.
    const cap = { root: '', out: [] as string[], err: [] as string[] }
    const tainted = await executeTask({
      ...baseArgs(b, node(b, CACHEABLE), capturingLogger(cap)),
      executor: far(0),
      download: 'deferred' as const,
      taintedUpstream: true,
      deferred: deferred as never,
    } as never)
    expect([tainted.status, registered]).toEqual(['success', []])
    // 3. CONTROL, on its own run: a clean success DOES register, so the two
    // refusals above are the gates' doing and not a path that never fires.
    const ok = await executeTask({
      ...baseArgs(b, node(b, CACHEABLE), capturingLogger({ root: '', out: [], err: [] })),
      executor: far(0),
      download: 'deferred' as const,
      deferred: deferred as never,
    } as never)
    expect([ok.status, registered]).toEqual(['success', ['proj#build']])
  })

  it('a remote-ONLY task leaves this machine alone: no clean, no restore, no local save', async () => {
    // `exec.remote: 'only'` on an executor that reports `remote: true` means
    // the work AND its result live on the far side — "restoring node_modules
    // onto a dev machine is exactly what the field exists to prevent". The
    // comment lists three consequences (no probe/restore, no output clean, no
    // local artifact save) and nothing pinned any of them (2026-09-20).
    const b = await bench()
    try {
      // A leftover under the declared output, and a cache that would notice a
      // save: both survive untouched if the three claims hold.
      await writeFile(path.join(b.dir, 'out.txt'), 'STRAY')
      const calls: string[] = []
      const far: TaskExecutor = {
        name: 'far-side',
        remote: true,
        async execute(req: ExecuteRequest) {
          calls.push(req.taskId)
          return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
        },
      }
      const getSpy = spyOn(b.cache, 'get')
      const o = await executeTask({
        ...baseArgs(b, node(b, CACHEABLE), capturingLogger({ root: '', out: [], err: [] })),
        executor: far,
        remoteOnly: true,
      })
      expect({ status: o.status, ran: calls }).toEqual({ status: 'success', ran: ['proj#build'] })
      // No probe, and no restore that a probe would have fed.
      expect(getSpy).toHaveBeenCalledTimes(0)
      // No clean: the leftover is still exactly as it was, and the command
      // that would have overwritten it ran on the far side, not here.
      expect(await readFile(path.join(b.dir, 'out.txt'), 'utf8')).toBe('STRAY')
      // No local artifact: nothing was saved under this task's key.
      expect(b.cache.loadOutputFilesBatch([o.hash ?? '']).size).toBe(0)
      getSpy.mockRestore()
    } finally {
      await closeBench(b)
    }
  })

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

describe('execute-task — binary resolution: project bin, then the workspace root', () => {
  // A monorepo declares its shared tooling ONCE, at the root, so a member's
  // own `node_modules/.bin` never contains it. With only the project entry on
  // PATH such a task exits 127 — which is exactly what this repo's gate did
  // the moment core stopped BEING the root and the two paths stopped
  // coinciding. The REAPI executor already rebuilds both entries in the
  // action's command, so the divergence also meant a task could resolve on a
  // worker and fail on the machine that submitted it.
  const writeBin = async (dir: string, name: string, body: string): Promise<void> => {
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }

  it(
    'a root-only binary resolves from a project that is not the root',
    async () => {
      const b = await bench()
      try {
        await writeBin(path.join(b.root, 'node_modules', '.bin'), 'shared-tool', 'echo from-root')
        const log = capturingLogger({ root: '', out: [], err: [] })
        const n = node(b, { exec: { command: 'shared-tool' } }, 'proj#tool')
        const outcome = await executeTask(baseArgs(b, n, log))
        expect(outcome.exitCode).toBe(0)
        expect(outcome.status).toBe('success')
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  it(
    "the project's own bin WINS over a same-named root binary",
    async () => {
      const b = await bench()
      try {
        await writeBin(path.join(b.root, 'node_modules', '.bin'), 'dup', 'echo from-root')
        await writeBin(path.join(b.dir, 'node_modules', '.bin'), 'dup', 'echo from-project')
        const cap = { root: '', out: [] as string[], err: [] as string[] }
        const log = capturingLogger(cap)
        const n = node(b, { exec: { command: 'dup' } }, 'proj#dup')
        await executeTask(baseArgs(b, n, log))
        expect(cap.out.join('')).toContain('from-project')
        expect(cap.out.join('')).not.toContain('from-root')
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  // CONTROL: the widening is the ROOT, not the ancestor chain. A sibling
  // project's bin stays invisible — that is the project-isolation rule, and
  // without this pin "resolve the root too" could drift into "walk up".
  it(
    "a SIBLING project's bin stays invisible",
    async () => {
      const b = await bench()
      try {
        const sibling = path.join(b.root, 'other')
        await writeBin(path.join(sibling, 'node_modules', '.bin'), 'sib-only', 'echo leaked')
        const log = capturingLogger({ root: '', out: [], err: [] })
        const n = node(b, { exec: { command: 'sib-only' } }, 'proj#sib')
        const outcome = await executeTask(baseArgs(b, n, log))
        expect(outcome.exitCode).toBe(127)
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )
})

describe('execute-task — the executor seam checks what a plugin resolves', () => {
  // A plugin executor that resolved `{}` met `res.violations` in core and
  // became "internal error in <task>: TypeError" — vx's crash for the
  // plugin's bug (item 251). The seam names the executor and the field.
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a malformed result is a UserError naming the executor and the field, never a TypeError',
    async () => {
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const n = node(b, { exec: { command: 'true' } }, 'proj#bad')
        const bad = { name: 'org/bad', execute: async () => ({}) } as never
        let caught: unknown
        try {
          await executeTask({ ...baseArgs(b, n, log), executor: bad })
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(UserError)
        expect((caught as Error).message).toBe(
          "executor 'org/bad' returned an invalid result for proj#bad: exitCode is undefined (expected a number) — a plugin bug, not a task failure",
        )
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  // CONTROL: a well-formed result from a plugin executor is a plain outcome.
  it(
    "a well-formed result from a plugin executor is the task's outcome",
    async () => {
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const n = node(b, { exec: { command: 'true' } }, 'proj#good')
        const good = {
          name: 'org/good',
          execute: async () => ({
            exitCode: 0,
            durationMs: 1,
            stdout: 'ran\n',
            stderr: '',
            violations: [],
          }),
        } as never
        const outcome = await executeTask({ ...baseArgs(b, n, log), executor: good })
        expect([outcome.status, outcome.exitCode]).toEqual(['success', 0])
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )
})

describe('execute-task — a group is transparent to the executor input set', () => {
  // A group has no `exec`, so it produces nothing and has no cache entry — its
  // hash is a synthetic roll-up. That is fine for the KEY (dependents cascade
  // through the roll-up) and was silently wrong for `ExecuteRequest.inputs`,
  // whose whole job is to describe the closure an input-shipping executor must
  // place in the input root. A dependent of a group received one upstream row
  // with an EMPTY output list, which is invisible locally — the members'
  // outputs are already on disk, put there by their own tasks — and fatal
  // remotely: `dependsOn: ['install']` shipped a worker an action containing
  // none of what `install` chains.
  it(
    'a dependent of a group sees the tasks BENEATH it, with their outputs',
    async () => {
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })

        // A real producer with a real cache entry: the upstream output list is
        // read from the local index by HASH, so a hand-made outcome would prove
        // nothing about what a dependent actually receives.
        const producer = node(
          b,
          {
            exec: { command: 'mkdir -p dist && echo built > dist/lib.js' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
          },
          'proj#compile',
        )
        const made = await executeTask(baseArgs(b, producer, log))
        expect(made.status).toBe('success')

        // The group the user actually depends on.
        const group = node(b, { dependsOn: ['compile'] }, 'proj#install')
        const groupOutcome = await executeTask({
          ...baseArgs(b, group, log),
          upstream: [made],
        })
        expect(groupOutcome.groupUpstream?.map((u) => u.node.id)).toEqual(['proj#compile'])

        let seen: ExecuteRequest | undefined
        const capturing: TaskExecutor = {
          name: 'capture',
          execute: (req) => {
            seen = req
            return localExecutor().execute(req)
          },
        }
        const consumer = node(
          b,
          {
            dependsOn: ['install'],
            exec: { command: 'true' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
          },
          'proj#bundle',
        )
        await executeTask({
          ...baseArgs(b, consumer, log),
          upstream: [groupOutcome],
          executor: capturing,
        })

        // The group itself is NOT in the list — it has nothing to contribute and
        // naming it would send an executor looking for an entry that cannot exist.
        expect(seen?.inputs?.upstream.map((u) => u.taskId)).toEqual(['proj#compile'])
        expect(seen?.inputs?.upstream[0]?.hash).toBe(made.hash)
        expect(seen?.inputs?.upstream[0]?.outputs).toEqual(['proj/dist/lib.js'])
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  // CONTROL: the expansion must not change what the KEY folds. The key
  // cascades through the group's own roll-up hash and always has; folding the
  // members too would move every existing dependent's key to say something the
  // roll-up already said, for no gain.
  it(
    'expanding the group does not move the dependent cache key',
    async () => {
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const consumer = node(
          b,
          {
            dependsOn: ['install'],
            exec: { command: 'true' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
          },
          'proj#bundle',
        )
        const member = upstreamOutcome('proj#compile', 'aaaaaaaaaaaaaaaa')
        const bare = { ...upstreamOutcome('proj#install', 'gggggggggggggggg') }
        const withMembers: TaskOutcome = { ...bare, groupUpstream: [member] }

        const a = await executeTask({ ...baseArgs(b, consumer, log), upstream: [bare] })
        const c = await executeTask({ ...baseArgs(b, consumer, log), upstream: [withMembers] })
        expect(a.hash).toBe(c.hash)
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )
})

describe('execute-task — the executor input set is ADDRESSED and ORDERED', () => {
  // `describeTaskInputs` builds `ExecuteRequest.inputs` — the closure an
  // input-shipping executor places in a remote input root. The rows above
  // pin WHICH upstream tasks appear; these pin the two things said about
  // the rows themselves: where each output file lives, and in what order.

  it(
    'a workspace-level upstream output is addressed from the WORKSPACE root',
    async () => {
      // Workspace outputs are stored under the artifact's second namespace,
      // so the index row reads `workspace-outputs/<path-from-the-root>`.
      // That prefix is a STORAGE discriminator: the path behind it is
      // already workspace-relative, while a project output's row is
      // relative to the project dir and has to be rebased. Treat the two
      // alike and the executor is handed `proj/workspace-outputs/shared/…`
      // — a file that exists nowhere, so a worker stages nothing and the
      // task runs without the upstream output it declared a dependency on.
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })

        // One producer, both namespaces: the project output proves the
        // rebase still happens for a project path in the same list, so the
        // row cannot pass by treating every path as workspace-relative.
        const producer = node(
          b,
          {
            exec: {
              command:
                'mkdir -p dist ../shared && echo p > dist/lib.js && echo w > ../shared/gen.txt',
            },
            cache: {
              inputs: { files: ['package.json'] },
              outputs: { files: ['dist/**'], workspaceFiles: ['shared/**'] },
            },
          },
          'proj#compile',
        )
        const made = await executeTask(baseArgs(b, producer, log))
        expect(made.status).toBe('success')

        let seen: ExecuteRequest | undefined
        const capturing: TaskExecutor = {
          name: 'capture',
          execute: (req) => {
            seen = req
            return localExecutor().execute(req)
          },
        }
        const consumer = node(
          b,
          {
            dependsOn: ['compile'],
            exec: { command: 'true' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
          },
          'proj#bundle',
        )
        await executeTask({
          ...baseArgs(b, consumer, log),
          upstream: [made],
          executor: capturing,
        })

        expect(seen?.inputs?.upstream[0]?.outputs?.slice().sort()).toEqual([
          'proj/dist/lib.js',
          'shared/gen.txt',
        ])
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  it(
    'the upstream list is ordered by hash, not by declaration order',
    async () => {
      // The docblock says the list — "and any action digest derived from
      // it" — is independent of dependency declaration order. A remote
      // executor that digests this list keys its action on it, so an order
      // that follows `dependsOn` gives the same closure two digests and
      // every reordering of a `dependsOn` array is a remote cache miss.
      // Asserting sortedness alone would pass half the time on two
      // members; asserting that BOTH declaration orders produce the same
      // list cannot, whichever way the hashes happen to sort.
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const first = upstreamOutcome('proj#alpha', 'ffffffffffffffff')
        const second = upstreamOutcome('proj#beta', '1111111111111111')

        const consumer = node(
          b,
          {
            dependsOn: ['alpha', 'beta'],
            exec: { command: 'true' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
          },
          'proj#bundle',
        )
        const listFor = async (upstream: TaskOutcome[]): Promise<string[] | undefined> => {
          let seen: ExecuteRequest | undefined
          const capturing: TaskExecutor = {
            name: 'capture',
            execute: (req) => {
              seen = req
              return localExecutor().execute(req)
            },
          }
          await executeTask({
            ...baseArgs(b, consumer, log),
            upstream,
            executor: capturing,
            cachePolicy: NO_CACHE,
          })
          return seen?.inputs?.upstream.map((u) => u.taskId)
        }

        const declared = await listFor([first, second])
        const reversed = await listFor([second, first])
        expect(declared).toEqual(['proj#beta', 'proj#alpha'])
        expect(reversed).toEqual(declared)
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )
})

describe('execute-task — cache.inputs.tasks filters the KEY, not the input set', () => {
  // `cache.inputs.tasks` is defined as "which upstream tasks' cache KEYS
  // participate in this task's KEY" — an invalidation statement. What a task
  // may READ is `dependsOn`, and locally every dependency's outputs are on
  // disk before the command runs no matter what the filter says. So an
  // executor that ships the input closure must ship the dependency closure;
  // deriving it from the filtered set instead means a task decoupled from an
  // upstream's key silently loses that upstream's BYTES when it runs remotely,
  // while behaving correctly on the machine that submitted it.
  it(
    'an upstream excluded from the key is still in the input closure',
    async () => {
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const producer = node(
          b,
          {
            exec: { command: 'mkdir -p dist && echo built > dist/lib.js' },
            cache: { inputs: { files: ['package.json'] }, outputs: { files: ['dist/**'] } },
          },
          'proj#compile',
        )
        const made = await executeTask(baseArgs(b, producer, log))
        expect(made.status).toBe('success')

        let seen: ExecuteRequest | undefined
        const capturing: TaskExecutor = {
          name: 'capture',
          execute: (req) => {
            seen = req
            return localExecutor().execute(req)
          },
        }
        const consumer = node(
          b,
          {
            dependsOn: ['compile'],
            exec: { command: 'true' },
            // Decoupled from every upstream KEY — and still depends on compile.
            cache: { inputs: { files: ['package.json'], tasks: [] }, outputs: { files: [] } },
          },
          'proj#bundle',
        )
        await executeTask({
          ...baseArgs(b, consumer, log),
          upstream: [made],
          executor: capturing,
        })

        expect(seen?.inputs?.upstream.map((u) => u.taskId)).toEqual(['proj#compile'])
        expect(seen?.inputs?.upstream[0]?.outputs).toEqual(['proj/dist/lib.js'])
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )

  // CONTROL: the filter still does its actual job. Excluding an upstream must
  // still change nothing about the key when that upstream's hash moves.
  it(
    'the filter still decouples the KEY',
    async () => {
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })
        const consumer = node(
          b,
          {
            dependsOn: ['compile'],
            exec: { command: 'true' },
            cache: { inputs: { files: ['package.json'], tasks: [] }, outputs: { files: [] } },
          },
          'proj#bundle',
        )
        const drive = (hash: string) =>
          executeTask({
            ...baseArgs(b, consumer, log),
            upstream: [upstreamOutcome('proj#compile', hash)],
          })
        const a = await drive('aaaaaaaaaaaaaaaa')
        const c = await drive('bbbbbbbbbbbbbbbb')
        expect(a.hash).toBe(c.hash)
      } finally {
        await closeBench(b)
      }
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

describe('execute-task — `--force` reaches a remote executor through `refresh`', () => {
  // `--force` is "re-execute everything (skip reads) but still refresh the
  // cache". vx's own cache honours that through the policy gates above — but
  // an executor keeps its OWN record of what it has already run, and no
  // policy of vx's can reach inside it. `ExecuteRequest.refresh` is the whole
  // channel: without it a `--force` run is handed the executor's cached
  // answer, and the user's explicit re-execute is silently ignored on exactly
  // the tasks that went remote.
  //
  // @vzn/vx-reapi pins the CONSUMER half — "refresh (--force) bypasses the
  // execution record and re-executes" — but that row BUILDS its own request,
  // so nothing in it says core ever sets the flag. This is the producer half,
  // and it is asserted here because the only shipped consumer needs live
  // service containers the gate does not have.
  const capturing = (): { seen: () => ExecuteRequest | undefined; executor: TaskExecutor } => {
    let req: ExecuteRequest | undefined
    return {
      seen: () => req,
      executor: {
        name: 'capture',
        execute: (r) => {
          req = r
          return localExecutor().execute(r)
        },
      },
    }
  }

  const cacheable: TaskNode['config'] = {
    exec: { command: 'true' },
    cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
  }

  it(
    'reads off sets it; reads on does not; and an UNCACHEABLE task never does',
    async () => {
      const b = await bench()
      try {
        const log = capturingLogger({ root: '', out: [], err: [] })

        const forced = capturing()
        await executeTask({
          ...baseArgs(b, node(b, cacheable), log),
          executor: forced.executor,
          cachePolicy: FORCE,
        })
        expect(forced.seen()?.refresh).toBe(true)

        // CONTROL: the default policy must leave the executor's own record
        // usable, or every ordinary run pays a remote re-execution.
        const normal = capturing()
        await executeTask({
          ...baseArgs(b, node(b, cacheable, 'proj#build2'), log),
          executor: normal.executor,
        })
        expect(normal.seen()?.refresh).toBeUndefined()

        // A task with no `cache` block has no key for an executor to have
        // recorded anything under, so there is nothing to refresh.
        const bare = capturing()
        await executeTask({
          ...baseArgs(b, node(b, { exec: { command: 'true' } }, 'proj#bare'), log),
          executor: bare.executor,
          cachePolicy: FORCE,
        })
        expect(bare.seen()?.refresh).toBeUndefined()
      } finally {
        await closeBench(b)
      }
    },
    TIMEOUT,
  )
})
