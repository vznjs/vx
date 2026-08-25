// `vx mcp` — the surface an AI agent uses to reason about a user's build.
//
// Everything here arrives from a language model, so every argument is
// untrusted input and every number that goes back out is a claim the agent
// will act on. The failure class this file exists to make impossible is the
// one that already shipped (decision log, 2026-07-26): `getCacheStats`
// ADVERTISED a `scope: { project }`, IGNORED it, and then ECHOED IT BACK, so
// the response looked scoped while the numbers were workspace-wide. An agent
// had no way to tell it had been lied to.
//
// Two rules follow, and they shape most of this file:
//
//   1. A scope test must assert on the DATA, never on the echo. Seed two
//      projects, ask for one, and prove the answer is NARROWER than the
//      workspace total. Assert the echo separately, and only as a second
//      claim — an echo-only assertion is exactly what let the bug ship.
//   2. A bad argument must produce a NAMED error or a clamped value. An
//      opaque `SQLITE_MISMATCH` reaching an agent is unactionable, and a
//      silent fallback is worse: it answers a question nobody asked.
//
// Handler results also cross a serialization boundary that has no type: the
// server does `JSON.stringify(result)` (src/cli/mcp.ts:83). A bigint there
// THROWS and takes the tool call with it, so what survives the hop is pinned
// rather than assumed.
//
// The transport is not ours — `mcp.ts` hands framing to the SDK's
// `StdioServerTransport` — so the framing cases (two messages in one chunk, a
// message split across chunks) are driven end-to-end against a real
// `bun src/bin.ts mcp` subprocess rather than against a re-implementation.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Cache, type RunRecord } from '../src/cache/index.js'
import { handleMcpRequest, listMcpTools, setMcpContext } from '../src/cli/index.js'
import { VERSION } from '../src/version.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SRC_DIR = path.join(import.meta.dir, '..', 'src', 'cli')
const RPC_SRC = readFileSync(path.join(SRC_DIR, 'mcp-rpc.ts'), 'utf8')
const MCP_SRC = readFileSync(path.join(SRC_DIR, 'mcp.ts'), 'utf8')

function mkRun(args: Partial<RunRecord> & { project: string; task: string }): RunRecord {
  return {
    hash: args.hash ?? 'h',
    project: args.project,
    task: args.task,
    status: args.status ?? 'success',
    exitCode: args.exitCode ?? 0,
    durationMs: args.durationMs ?? 100,
    forwardArgs: [],
    startedAt: args.startedAt ?? Date.now() - 1000,
    endedAt: args.endedAt ?? Date.now() - 900,
    runId: args.runId ?? 'r-1',
    cpuMs: 50,
    peakRssBytes: 0,
    // Deliberately past Number.MAX_SAFE_INTEGER: these bind as bigints, and a
    // handler that ever SELECTs them would hand JSON.stringify a value it
    // cannot serialize. See "the JSON boundary" block.
    wallclockStartNs: 12_345_678_901_234_567n,
    wallclockEndNs: 98_765_432_109_876_543n,
    cacheHit: args.cacheHit ?? false,
  }
}

/**
 * `mkRun` defaults `cacheHit` to `false`, so a test that needs the UNKNOWN
 * (NULL) state must DELETE the key — assigning `undefined` is a type error
 * under `exactOptionalPropertyTypes` and would not persist NULL anyway.
 */
function unknownAware(run: RunRecord, cacheHit: boolean | undefined): RunRecord {
  if (cacheHit === undefined) {
    const { cacheHit: _drop, ...rest } = run
    return rest
  }
  return { ...run, cacheHit }
}

/** A workspace root with a cache.db the MCP context can be pointed at. */
function makeWorkspace(tag: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `vx-mcp-rpc-${tag}-`))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  return root
}

function seed(root: string, fn: (cache: Cache) => void): void {
  const cache = new Cache(path.join(root, '.vx', 'cache'))
  try {
    fn(cache)
  } finally {
    cache.close()
  }
}

/**
 * `recordRun` writes to `runs` only — an `entries` row is created by
 * save/ingest, which needs a real artifact. `explainCacheKey` reads `entries`,
 * so a test that only records runs would assert against a permanently-null
 * `latestEntry` and prove nothing.
 */
function seedEntry(
  cache: Cache,
  e: {
    hash: string
    project: string
    task: string
    command: string
    sizeBytes: number
    durationMs: number
    createdAt: number
  },
): void {
  cache
    .dbHandle()
    .query(
      `INSERT INTO entries(hash, project, task, command, exit_code, duration_ms, size_bytes, stdout, created_at, accessed_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, '', ?, ?)`,
    )
    .run(e.hash, e.project, e.task, e.command, e.durationMs, e.sizeBytes, e.createdAt, e.createdAt)
}

/**
 * The shared fixture. Numbers are deliberately ASYMMETRIC between the two
 * projects so a scoped read cannot accidentally equal the workspace total,
 * and they sum exactly so an unhonored scope shows up as arithmetic that
 * stops adding up.
 *
 *   @t/alpha  4 executed runs, 1 hit, 1 entry (4096 B)
 *   @t/beta   2 executed runs, 1 hit, 1 entry (8192 B)
 *   @t/gamma  a single SKIPPED row: a task of the run, but not an execution
 */
const MAIN = { root: '' }
let now = 0

beforeAll(() => {
  now = Date.now()
  MAIN.root = makeWorkspace('main')
  seed(MAIN.root, (cache) => {
    cache.recordRuns([
      mkRun({ hash: 'a1', project: '@t/alpha', task: 'build', runId: 'r1', startedAt: now - 9000 }),
      mkRun({ hash: 'a2', project: '@t/alpha', task: 'build', runId: 'r2', startedAt: now - 8000 }),
      mkRun({
        hash: 'a3',
        project: '@t/alpha',
        task: 'build',
        runId: 'r3',
        status: 'cache-hit',
        cacheHit: true,
        startedAt: now - 7000,
      }),
      mkRun({ hash: 'a4', project: '@t/alpha', task: 'test', runId: 'r4', startedAt: now - 6000 }),
      mkRun({
        hash: 'b1',
        project: '@t/beta',
        task: 'build',
        runId: 'r5',
        status: 'failed',
        exitCode: 2,
        startedAt: now - 5000,
      }),
      mkRun({
        hash: 'b2',
        project: '@t/beta',
        task: 'build',
        runId: 'r6',
        status: 'cache-hit-remote',
        cacheHit: true,
        startedAt: now - 4000,
      }),
      // A skip has no exit of its own, no duration, no cache decision. It is
      // recorded (the dashboard must see it) but must never count as an
      // execution — see EXECUTED_RUNS_SQL.
      mkRun({
        hash: '',
        project: '@t/gamma',
        task: 'lint',
        runId: 'r7',
        status: 'skipped',
        startedAt: now - 3000,
      }),
    ])
    seedEntry(cache, {
      hash: 'a3',
      project: '@t/alpha',
      task: 'build',
      command: 'tsc -b',
      sizeBytes: 4096,
      durationMs: 123,
      createdAt: now - 7000,
    })
    seedEntry(cache, {
      hash: 'b2',
      project: '@t/beta',
      task: 'build',
      command: 'vitest run',
      sizeBytes: 8192,
      durationMs: 456,
      createdAt: now - 4000,
    })
  })
})

afterAll(() => {
  rmSync(MAIN.root, { recursive: true, force: true })
})

// `mcpContext` is module-level mutable state and bun runs every test FILE in
// one process, so a leaked root would silently retarget mcp.test.ts's handlers
// at this file's cache.db (or vice versa).
afterEach(() => {
  setMcpContext({})
})

/** Run a handler against a specific workspace root. */
async function call(root: string, tool: string, args: unknown): Promise<Record<string, unknown>> {
  setMcpContext({ workspaceRoot: root })
  try {
    return await handleMcpRequest(tool, args)
  } finally {
    setMcpContext({})
  }
}

type Stats = {
  scope: unknown
  entryCount: number
  totalBytes: number
  runCountLast24h: number
  hitCountLast24h: number
  hitRate24h: number
}
type HistoryEntry = { id: string; runs: number; p50DurationMs?: number; failureMode: string }
type RunRow = { runId: string | null; project: string; task: string; status: string }
type History = { runs: RunRow[]; history: HistoryEntry[] }
type Explain = {
  taskId: string
  project: string
  task: string
  latestEntry: { hash: string; command: string; sizeBytes: number } | null
}
type Why = {
  runId: string
  taskId: string
  found: boolean
  thisRun?: { hash: string }
  previousRun?: { hash: string } | null
  hashChanged?: boolean | null
  note: string
}

// ---------------------------------------------------------------------------
// The advertised set and the dispatched set
// ---------------------------------------------------------------------------

describe('the tool listing and the dispatcher describe the same set', () => {
  /**
   * Tool names the `handleMcpRequest` switch actually handles, read from
   * source. The failure this catches is an OMISSION — a tool added to TOOLS
   * but never dispatched answers `unknown tool`, and one dispatched but never
   * listed is invisible to every client — and an omission has no runtime shape
   * to assert against from one side alone.
   *
   * TRAP: this only works while the dispatch stays a literal `switch` over
   * string literals. If it becomes a computed lookup the regex matches
   * nothing, so the health check below must FAIL LOUDLY rather than be
   * relaxed away.
   */
  function dispatchedTools(): string[] {
    const fn = /export async function handleMcpRequest\([\s\S]*?\n\}/.exec(RPC_SRC)
    if (fn === null) {
      throw new Error(
        'mcp-rpc drift guard: could not find `export async function handleMcpRequest` — the ' +
          'dispatcher shape changed and this guard must be rewritten, not deleted',
      )
    }
    return [...fn[0].matchAll(/case '([^']+)':/g)].map((m) => m[1]!).sort()
  }

  it('parses a healthy dispatch table, so the checks below are not vacuous', () => {
    expect(dispatchedTools().length).toBeGreaterThanOrEqual(4)
    expect(dispatchedTools()).toContain('getCacheStats')
  })

  it('every advertised tool is dispatched, and every dispatched tool is advertised', () => {
    const advertised = listMcpTools()
      .map((t) => t.name)
      .sort()
    // One assertion, both directions, so the failure message names which side
    // drifted instead of just "expected 4 got 5".
    expect({ advertised, dispatched: dispatchedTools() }).toEqual({
      advertised,
      dispatched: advertised,
    })
  })

  it('every advertised tool actually answers rather than falling through', async () => {
    // The other half of the two-way check, at runtime: a `case` label that
    // does not match its TOOLS entry byte-for-byte (a typo, a rename on one
    // side) still parses fine above but throws here.
    for (const tool of listMcpTools()) {
      const attempt = call(MAIN.root, tool.name, {})
      // Some tools require arguments; what matters is that the name RESOLVES,
      // i.e. the failure is never "unknown tool".
      await attempt.catch((err: unknown) => {
        expect(String(err)).not.toMatch(/unknown tool/)
      })
    }
  })

  it('each tool advertises an object schema an SDK client can validate against', () => {
    for (const t of listMcpTools()) {
      const schema = t.inputSchema as { type?: unknown; properties?: unknown }
      expect({ name: t.name, type: schema.type }).toEqual({ name: t.name, type: 'object' })
      expect(typeof schema.properties).toBe('object')
    }
  })

  // FINDING — src/cli/mcp.ts:13 advertises a tool that does not exist.
  //
  // The file header lists `runTasks(tasks: string[], cwd?: string)` under
  // "Tools exposed:", but no such entry exists in TOOLS and no such `case`
  // exists in the dispatcher. It is the ONE tool in that list that would let an
  // agent change the user's machine, so a reader (or a model given this file as
  // context) concludes `vx mcp` can execute builds when it can only read them.
  //
  // The assertion below encodes the WRONG-BUT-CURRENT state: the comment is a
  // strict superset, and `runTasks` is the extra. Deleting the stale line — the
  // fix — will fail this test; update the expectation and drop this note then.
  it('the header does not restate the tool list, so it cannot drift again', () => {
    // This began as a FINDING: the header carried a hand-maintained copy of the
    // tool list, and the copy had drifted into advertising
    // `runTasks(tasks, cwd)` — a tool that does not exist, and the ONLY one in
    // that list which would have mutated the machine. A reader, or an agent
    // reading the source, concluded `vx mcp` can execute builds.
    //
    // The repair is not a corrected copy — a second copy drifts again. The
    // list is gone, and this asserts it stays gone. A comment enumerating what
    // a function returns is the "comment restating the code" the conventions
    // already ban; here it also shipped a false capability claim.
    expect(MCP_SRC).not.toContain('// Tools exposed:')
    for (const name of listMcpTools().map((t) => t.name)) {
      expect(MCP_SRC).not.toContain(`//   ${name}(`)
    }
    // The header must still point at where the truth lives, or removing the
    // list just makes the surface undiscoverable.
    expect(MCP_SRC).toContain('listMcpTools')
    // And no tool named runTasks exists, which is the claim that misled.
    expect(listMcpTools().map((t) => t.name)).not.toContain('runTasks')
  })
})

// ---------------------------------------------------------------------------
// getCacheStats — the scope
// ---------------------------------------------------------------------------

describe('getCacheStats — a scope must NARROW the data, not just echo', () => {
  it('a project scope narrows every aggregate, and the parts sum to the whole', async () => {
    const all = (await call(MAIN.root, 'getCacheStats', {})) as Stats
    const alpha = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: '@t/alpha' },
    })) as Stats
    const beta = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: '@t/beta' },
    })) as Stats

    // Workspace-wide: 6 executed runs (the skipped row is not an execution).
    expect(all.runCountLast24h).toBe(6)
    expect(all.entryCount).toBe(2)
    expect(all.totalBytes).toBe(12_288)

    // Each scope is STRICTLY smaller and distinct from the total — an echoed
    // but unhonored scope returned this same 6/2/12288 for every project.
    expect(alpha.runCountLast24h).toBe(4)
    expect(beta.runCountLast24h).toBe(2)
    // The ENTRY aggregates scope too. `Cache.stats` runs two separate queries
    // (entries, then runs), so one of them can be scoped while the other is
    // not — which reads as a plausible number rather than an obvious bug.
    expect(alpha.entryCount).toBe(1)
    expect(alpha.totalBytes).toBe(4096)
    expect(beta.entryCount).toBe(1)
    expect(beta.totalBytes).toBe(8192)

    // Arithmetic the unhonored version cannot satisfy: 4 + 2 = 6, not 12.
    expect(alpha.runCountLast24h + beta.runCountLast24h).toBe(all.runCountLast24h)
    expect(alpha.totalBytes + beta.totalBytes).toBe(all.totalBytes)
  })

  it('the hit rate is recomputed per scope, not sliced off the workspace rate', async () => {
    // The two projects have deliberately different hit rates (1/4 vs 1/2)
    // against a workspace rate of 2/6. All three values differ, so a handler
    // that scoped the counts but reused the global ratio still fails.
    const all = (await call(MAIN.root, 'getCacheStats', {})) as Stats
    const alpha = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: '@t/alpha' },
    })) as Stats
    const beta = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: '@t/beta' },
    })) as Stats
    expect(all.hitRate24h).toBeCloseTo(2 / 6, 10)
    expect(alpha.hitRate24h).toBeCloseTo(1 / 4, 10)
    expect(beta.hitRate24h).toBeCloseTo(1 / 2, 10)
  })

  it('the echoed scope agrees with the data it describes', async () => {
    // Asserted SEPARATELY and second, on purpose. The echo is how a client
    // labels the answer, so it must be right — but it is worthless as evidence
    // that the scope was honored, which is why it gets its own test.
    const scoped = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: '@t/beta' },
    })) as Stats
    expect(scoped.scope).toEqual({ project: '@t/beta' })
    const unscoped = (await call(MAIN.root, 'getCacheStats', {})) as Stats
    expect(unscoped.scope).toBe('all')
    expect((await call(MAIN.root, 'getCacheStats', { scope: 'all' })).scope).toBe('all')
  })

  it('a project that only ever SKIPPED reports zero executions', async () => {
    // @t/gamma has a row in `runs`, so a scope that merely counted rows would
    // answer 1. A skip is a task of the run but not an execution: counting one
    // in a rate reports a non-event as data.
    const gamma = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: '@t/gamma' },
    })) as Stats
    expect(gamma.runCountLast24h).toBe(0)
    expect(gamma.hitCountLast24h).toBe(0)
    expect(gamma.entryCount).toBe(0)
  })

  it('an unknown project answers a real zero rather than the workspace total', async () => {
    // The sharpest shape of the original defect: a typo'd project name. Under
    // an unhonored scope this returned the full workspace numbers labelled
    // with a project that does not exist.
    const missing = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: 'NO-SUCH-PROJECT' },
    })) as Stats
    expect(missing.runCountLast24h).toBe(0)
    expect(missing.entryCount).toBe(0)
    expect(missing.totalBytes).toBe(0)
    expect(missing.scope).toEqual({ project: 'NO-SUCH-PROJECT' })
  })
})

describe('getCacheStats — argument validation at the model boundary', () => {
  // Every one of these is a shape a model plausibly emits from the declared
  // `oneOf` schema. The contract is a NAMED error naming both valid forms —
  // never a silent coercion to 'all', which would answer a different question
  // under the caller's label.
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['a bare string that is not "all"', 'everything'],
    ['the project name passed directly', '@t/alpha'],
    ['an empty string', ''],
    ['null', null],
    ['a number', 7],
    ['a boolean', true],
    ['an object with no project key', {}],
    ['a non-string project', { project: 7 }],
    ['a null project', { project: null }],
    ['an EMPTY project name', { project: '' }],
    ['an array of projects', ['@t/alpha']],
    ['a nested scope object', { scope: { project: '@t/alpha' } }],
  ]

  for (const [what, scope] of rejected) {
    it(`refuses ${what}`, async () => {
      await expect(call(MAIN.root, 'getCacheStats', { scope })).rejects.toThrow(
        /scope must be "all" or/,
      )
    })
  }

  it('accepts the two documented forms plus an absent scope', async () => {
    // The guard must not overshoot: these three are the whole legal surface.
    for (const args of [{}, { scope: 'all' }, { scope: undefined }, { scope: { project: 'x' } }]) {
      await expect(call(MAIN.root, 'getCacheStats', args)).resolves.toBeDefined()
    }
  })

  it('validates BEFORE touching the workspace, so the error names the real cause', async () => {
    // Pointed at a directory that does not exist. If validation ran after
    // `openCache`, a bad scope would surface as a filesystem or SQLite error
    // and the agent would go hunting for a missing workspace instead of
    // fixing its argument.
    const ghost = path.join(tmpdir(), `vx-mcp-ghost-${Date.now()}`)
    try {
      await expect(call(ghost, 'getCacheStats', { scope: 'nope' })).rejects.toThrow(
        /scope must be "all" or/,
      )
    } finally {
      rmSync(ghost, { recursive: true, force: true })
    }
  })

  it('an entirely absent argument object is the same as no scope', async () => {
    // The SDK omits `arguments` for a no-argument call, so `argsRaw` really is
    // undefined on the wire — not `{}`.
    setMcpContext({ workspaceRoot: MAIN.root })
    try {
      const a = (await handleMcpRequest('getCacheStats', undefined)) as Stats
      const b = (await handleMcpRequest('getCacheStats', null)) as Stats
      expect(a.scope).toBe('all')
      expect(b.scope).toBe('all')
      expect(a.runCountLast24h).toBe(6)
    } finally {
      setMcpContext({})
    }
  })
})

// ---------------------------------------------------------------------------
// getRunHistory
// ---------------------------------------------------------------------------

describe('getRunHistory — filters narrow the data', () => {
  it('a project filter narrows BOTH halves of the response', async () => {
    // `runs` and `history` are two separate queries sharing one WHERE clause.
    // Either could be filtered while the other is not, which reads as a
    // response about one project containing another project's aggregates.
    const all = (await call(MAIN.root, 'getRunHistory', { limit: 100 })) as History
    const alpha = (await call(MAIN.root, 'getRunHistory', {
      project: '@t/alpha',
      limit: 100,
    })) as History

    expect(all.runs.length).toBe(7)
    expect(alpha.runs.length).toBe(4)
    expect(new Set(alpha.runs.map((r) => r.project))).toEqual(new Set(['@t/alpha']))
    expect(alpha.history.map((h) => h.id).sort()).toEqual(['@t/alpha#build', '@t/alpha#test'])
    // Nothing from the other project leaked into the aggregates.
    expect(alpha.history.some((h) => h.id.startsWith('@t/beta'))).toBe(false)
  })

  it('a task filter narrows across projects', async () => {
    // `task` without `project` is a legitimate cross-project question ("how is
    // `build` doing everywhere?"), so it must not silently require a project.
    const build = (await call(MAIN.root, 'getRunHistory', { task: 'build', limit: 100 })) as History
    expect(new Set(build.runs.map((r) => r.task))).toEqual(new Set(['build']))
    expect(build.history.map((h) => h.id).sort()).toEqual(['@t/alpha#build', '@t/beta#build'])
  })

  it('project + task compose into a single pair', async () => {
    const one = (await call(MAIN.root, 'getRunHistory', {
      project: '@t/alpha',
      task: 'test',
      limit: 100,
    })) as History
    expect(one.runs.length).toBe(1)
    expect(one.history.map((h) => h.id)).toEqual(['@t/alpha#test'])
  })

  it('an unknown project answers a shaped empty, not the whole workspace', async () => {
    const none = (await call(MAIN.root, 'getRunHistory', { project: 'NOPE' })) as History
    expect(none).toEqual({ runs: [], history: [] })
  })

  it('a non-string filter is REFUSED rather than silently ignored', async () => {
    // Was a FINDING: a model sending `{ project: 42 }` — or `["@t/alpha"]`, an
    // easy mistake against a schema with no `required` — got the ENTIRE
    // workspace back. The response carries no echo of the filter either, so
    // nothing in the payload said the narrowing had not happened, and the agent
    // then reasoned about every project's history believing it saw one.
    //
    // Refused, not coerced: MCP is an external API, which is exactly where this
    // project's rule says to validate.
    for (const bad of [42, ['@t/alpha'], { name: '@t/alpha' }, true, '']) {
      await expect(call(MAIN.root, 'getRunHistory', { project: bad, limit: 100 })).rejects.toThrow(
        /project must be a non-empty string/,
      )
    }
    // The control: a well-formed filter still narrows, so the guard did not
    // simply break the feature.
    const all = (await call(MAIN.root, 'getRunHistory', { limit: 100 })) as History
    const one = (await call(MAIN.root, 'getRunHistory', {
      project: '@t/alpha',
      limit: 100,
    })) as History
    expect(one.runs.length).toBeGreaterThan(0)
    expect(one.runs.length).toBeLessThan(all.runs.length)
  })

  it('the two halves disagree about skips on purpose, and neither invents data', async () => {
    // `runs` is a COMPLETENESS surface — a skipped task genuinely happened and
    // showing it is the point. `history` is an AGGREGATE — a skip has no
    // duration and no outcome, so it cannot contribute to a rate.
    //
    // For @t/gamma, which has ONLY a skipped row, that means the pair appears
    // in `runs` and is absent from `history`. Absent is the honest answer; the
    // tempting "fix" is a zeroed aggregate, which would tell an agent the task
    // has a 0% success rate when it has simply never executed.
    const gamma = (await call(MAIN.root, 'getRunHistory', { project: '@t/gamma' })) as History
    expect(gamma.runs.map((r) => r.status)).toEqual(['skipped'])
    expect(gamma.history).toEqual([])
  })

  it('a pair aggregate counts its own history, not the requested page', async () => {
    // `runs.length` is bounded by `limit`; `history[].runs` is the count over
    // that pair's own recent window. They legitimately differ, and reading one
    // as the other would badly misreport how often a task runs.
    const page = (await call(MAIN.root, 'getRunHistory', {
      project: '@t/alpha',
      task: 'build',
      limit: 1,
    })) as History
    expect(page.runs.length).toBe(1)
    expect(page.history[0]!.runs).toBe(3)
  })

  it('keeps the MOST RECENTLY RUN pair when the page truncates', async () => {
    // The bug this guards is real and shipped once in the sibling
    // `metrics.getHistory`: a `SELECT DISTINCT` whose ordering is dropped
    // returns the ALPHABETICAL prefix, which silently discards exactly the
    // task the developer just ran — the one they are asking about.
    const root = makeWorkspace('order')
    try {
      seed(root, (cache) => {
        const runs = Array.from({ length: 6 }, (_, i) =>
          mkRun({
            hash: `o${i}`,
            project: `aaa-${i}`,
            task: 'build',
            runId: `ro${i}`,
            startedAt: now - 900_000 + i,
          }),
        )
        // Sorts LAST alphabetically, ran FIRST chronologically.
        runs.push(
          mkRun({ hash: 'z', project: 'zzz-just-ran', task: 'build', runId: 'rz', startedAt: now }),
        )
        cache.recordRuns(runs)
      })
      const page = (await call(root, 'getRunHistory', { limit: 3 })) as History
      expect(page.history.map((h) => h.id)[0]).toBe('zzz-just-ran#build')
      expect(page.runs[0]!.project).toBe('zzz-just-ran')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('getRunHistory — the limit is untrusted input', () => {
  it('floors a fractional limit instead of failing the query', async () => {
    // SQLite answers `LIMIT 2.7` with `datatype mismatch`, not a smaller page,
    // and the MCP SDK does not enforce the schema's declared `type: integer` —
    // so an unfloored limit is an opaque database error reaching the agent.
    const got = (await call(MAIN.root, 'getRunHistory', { limit: 2.7 })) as History
    expect(got.runs.length).toBe(2)
  })

  it('clamps to at least one row for 0 and negatives', async () => {
    // A page of 0 is not a legal SQL question here, and a negative LIMIT means
    // "no limit" in SQLite — the exact inverse of what the caller asked.
    for (const limit of [0, -1, -1000, 0.5, -0]) {
      const got = (await call(MAIN.root, 'getRunHistory', { limit })) as History
      expect({ limit, n: got.runs.length }).toEqual({ limit, n: 1 })
    }
  })

  it('caps a huge limit at the advertised maximum of 500', async () => {
    // The schema says `maximum: 500`; nothing enforces it but the clamp. There
    // are only 7 rows here, so the observable claim is that a hostile value
    // still returns and returns the same page as a sane one.
    for (const limit of [500, 501, 1e9, Number.MAX_SAFE_INTEGER]) {
      const got = (await call(MAIN.root, 'getRunHistory', { limit })) as History
      expect({ limit, n: got.runs.length }).toEqual({ limit, n: 7 })
    }
  })

  it('holds at both ends of the declared range', async () => {
    expect(((await call(MAIN.root, 'getRunHistory', { limit: 1 })) as History).runs.length).toBe(1)
    expect(((await call(MAIN.root, 'getRunHistory', { limit: 7 })) as History).runs.length).toBe(7)
  })

  it('a limit of the wrong SHAPE is refused, not answered with a different one', async () => {
    // Was a FINDING: a model sending `"10"` asked for ten rows and got FIFTY,
    // with nothing in the response saying so — neither the named error the
    // boundary rule asks for nor a clamp of the stated intent, but a silent
    // answer to a different question.
    for (const limit of ['10', '2', null, true, [2], { n: 2 }]) {
      await expect(call(MAIN.root, 'getRunHistory', { limit })).rejects.toThrow(
        /limit must be a finite number between 1 and 500/,
      )
    }
    // Omitting it is still the documented default, and an in-range value is
    // still honoured — the refusal is about SHAPE, not about being strict.
    const dflt = (await call(MAIN.root, 'getRunHistory', {})) as History
    expect(dflt.runs.length).toBeGreaterThan(0)
    const two = (await call(MAIN.root, 'getRunHistory', { limit: 2 })) as History
    expect(two.runs.length).toBeLessThanOrEqual(2)
  })

  it('Infinity is refused instead of collapsing to ONE row', async () => {
    // The sharpest of the limit findings. `clampInt` sends any non-finite value
    // to MIN, not MAX — and JSON has no Infinity literal, but `{"limit":1e999}`
    // parses to one. So an agent reaching for "no limit" received a SINGLE row
    // and could reasonably conclude the workspace had run exactly one task.
    //
    // Fail-small is defensible; failing small SILENTLY on the value that means
    // "the most" is not. Refused, because there is no page size that honestly
    // represents either Infinity or NaN.
    expect(JSON.parse('{"limit":1e999}').limit).toBe(Number.POSITIVE_INFINITY)
    for (const limit of [Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY]) {
      await expect(call(MAIN.root, 'getRunHistory', { limit })).rejects.toThrow(
        /limit must be a finite number/,
      )
    }
    // Out-of-range but FINITE still clamps, because the published schema states
    // the 1..500 bounds — the refusal is for values with no honest reading.
    const big = (await call(MAIN.root, 'getRunHistory', { limit: 100_000 })) as History
    expect(big.runs.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// explainCacheKey
// ---------------------------------------------------------------------------

describe('explainCacheKey', () => {
  it('returns the persisted entry for a task that has one', async () => {
    // The existing suite asserts only the echoed taskId/project/task, which
    // pass with `latestEntry: null` — so the entry read itself was unpinned.
    const got = (await call(MAIN.root, 'explainCacheKey', {
      taskId: '@t/alpha#build',
    })) as Explain
    expect(got.project).toBe('@t/alpha')
    expect(got.task).toBe('build')
    expect(got.latestEntry).not.toBeNull()
    expect(got.latestEntry!.hash).toBe('a3')
    expect(got.latestEntry!.command).toBe('tsc -b')
    expect(got.latestEntry!.sizeBytes).toBe(4096)
  })

  it('reads the entry for the requested task, not just any entry', async () => {
    const beta = (await call(MAIN.root, 'explainCacheKey', { taskId: '@t/beta#build' })) as Explain
    expect(beta.latestEntry!.command).toBe('vitest run')
    expect(beta.latestEntry!.sizeBytes).toBe(8192)
  })

  it('answers latestEntry: null for a task with no cached entry', async () => {
    // A never-cached task must read as "nothing stored", explicitly null, so a
    // client can tell it apart from a missing field.
    const got = (await call(MAIN.root, 'explainCacheKey', { taskId: '@t/alpha#test' })) as Explain
    expect(got.latestEntry).toBeNull()
    expect(got.project).toBe('@t/alpha')
  })

  it('answers latestEntry: null for a project that does not exist at all', async () => {
    const got = (await call(MAIN.root, 'explainCacheKey', { taskId: 'ghost#task' })) as Explain
    expect(got).toMatchObject({ taskId: 'ghost#task', project: 'ghost', task: 'task' })
    expect(got.latestEntry).toBeNull()
  })

  it('says plainly that the input components are not in this answer', async () => {
    // The tool is named `explainCacheKey` and its description promises a
    // breakdown of "files / env / runtime / upstream". It returns none of
    // that. The note is the only thing stopping an agent from reporting the
    // absence of components as "this task has no inputs".
    const got = (await call(MAIN.root, 'explainCacheKey', {
      taskId: '@t/alpha#build',
    })) as Explain & { note: string }
    expect(got.note).toMatch(/require live config evaluation/)
  })

  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ['a missing taskId', undefined],
    ['null', null],
    ['a number', 7],
    ['an object', { project: 'a', task: 'b' }],
    ['an array', ['a', 'b']],
    ['a bare project with no separator', 'justaproject'],
    ['an empty string', ''],
  ]
  for (const [what, taskId] of malformed) {
    it(`refuses ${what}`, async () => {
      await expect(call(MAIN.root, 'explainCacheKey', { taskId })).rejects.toThrow(
        /taskId must be a "project#task" string/,
      )
    })
  }

  it('accepts the degenerate but well-formed halves rather than guessing', async () => {
    // `#build` and `pkg#` contain the separator, so they pass validation and
    // resolve to an empty project / empty task. Both answer null rather than
    // matching something by accident — pinned so a future "trim empties"
    // change has to argue with it.
    const noProject = (await call(MAIN.root, 'explainCacheKey', { taskId: '#build' })) as Explain
    expect({ project: noProject.project, task: noProject.task }).toEqual({
      project: '',
      task: 'build',
    })
    expect(noProject.latestEntry).toBeNull()
    const noTask = (await call(MAIN.root, 'explainCacheKey', { taskId: '@t/alpha#' })) as Explain
    expect(noTask.task).toBe('')
    expect(noTask.latestEntry).toBeNull()
  })

  // FINDING — src/cli/mcp-rpc.ts:223 (and the same `split('#', 2)` in
  // src/orchestrator/metrics.ts:750).
  //
  // `'a#b#c'.split('#', 2)` is `['a', 'b']` — the limit TRUNCATES rather than
  // keeping the remainder, so everything after the second `#` is discarded.
  // The handler then echoes the taskId the caller sent while answering about a
  // DIFFERENT task, which is precisely the echo-does-not-match-the-data class
  // the scope defect belonged to.
  //
  // `src/orchestrator/history.ts:186` splits the same id the other way (slice
  // from the FIRST `#`, remainder kept), so the two disagree about the same
  // string. Task names contain no `#` today, which is why this is a latent
  // inconsistency rather than a live bug — but the echo makes it silent if it
  // ever becomes reachable.
  it('splits on the FIRST # so a #-containing task name survives', async () => {
    // Was a FINDING: `taskId.split('#', 2)` discarded everything after the
    // second segment while echoing the full id back, so `a#b#c` was answered
    // with task `b`'s data under the label `a#b#c`.
    //
    // The divergence is what made it a correctness bug rather than cosmetics:
    // `parseDependencySpec` — the surface that decides what actually RUNS — has
    // always split on the first `#`, so the query layer and the graph disagreed
    // about the identity of the same task. Both now use `splitTaskId`.
    const got = (await call(MAIN.root, 'explainCacheKey', {
      taskId: '@t/alpha#build#extra',
    })) as Explain
    expect(got.taskId).toBe('@t/alpha#build#extra')
    // The task is `build#extra`, which is a different task from `build` — so
    // this reports no entry rather than confidently answering with `build`'s.
    expect(got.task).toBe('build#extra')
    expect(got.latestEntry).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// whyDidThisRerun
// ---------------------------------------------------------------------------

describe('whyDidThisRerun', () => {
  it('names the previous KEYED run and reports the key change', async () => {
    const got = (await call(MAIN.root, 'whyDidThisRerun', {
      runId: 'r3',
      taskId: '@t/alpha#build',
    })) as Why
    expect(got.found).toBe(true)
    expect(got.thisRun!.hash).toBe('a3')
    expect(got.previousRun!.hash).toBe('a2')
    expect(got.hashChanged).toBe(true)
    expect(got.note).toMatch(/inputs differ/)
  })

  it('reports no prior run for the first run of a task', async () => {
    // "First recorded run" and "the key did not change" are different answers;
    // conflating them is how a dashboard tells a developer their task has
    // never run beside a link to its previous run.
    const got = (await call(MAIN.root, 'whyDidThisRerun', {
      runId: 'r1',
      taskId: '@t/alpha#build',
    })) as Why
    expect(got.found).toBe(true)
    expect(got.previousRun).toBeNull()
    expect(got.hashChanged).toBeNull()
    expect(got.note).toMatch(/no prior run/)
  })

  it('refuses to compare when this run recorded no cache key', async () => {
    // A skipped (or persistent) task carries the `''` sentinel. Comparing it
    // to anything is a statement about inputs made from a row that has none —
    // so the verdict is null, not false.
    const got = (await call(MAIN.root, 'whyDidThisRerun', {
      runId: 'r7',
      taskId: '@t/gamma#lint',
    })) as Why
    expect(got.found).toBe(true)
    expect(got.hashChanged).toBeNull()
    expect(got.note).toMatch(/recorded no cache key/)
  })

  it('a keyless run with a KEYED predecessor still refuses to claim the inputs changed', async () => {
    // The sharp arm of the same rule, and the one the case above cannot reach:
    // here there IS a previous run with a real key, so a comparison is
    // available — `'' !== 'k1'` is trivially true. Reporting that as
    // "hashChanged: true" tells the developer their inputs changed when the
    // task simply never derived a key (its upstream failed, so it skipped).
    const root = makeWorkspace('nokey')
    try {
      seed(root, (cache) => {
        cache.recordRuns([
          mkRun({ hash: 'k1', project: 'p', task: 'lint', runId: 'n1', startedAt: now - 2000 }),
          mkRun({
            hash: '',
            project: 'p',
            task: 'lint',
            runId: 'n2',
            status: 'skipped',
            startedAt: now - 1000,
          }),
        ])
      })
      const got = (await call(root, 'whyDidThisRerun', { runId: 'n2', taskId: 'p#lint' })) as Why
      expect(got.previousRun!.hash).toBe('k1')
      expect(got.thisRun!.hash).toBe('')
      expect(got.hashChanged).toBeNull()
      expect(got.note).toMatch(/recorded no cache key/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an unchanged key reads differently for a HIT, an EXECUTION, and an unknown', async () => {
    // The verb answers "why did this RE-RUN?", so calling a cache hit a re-run
    // answered its own question wrong — and blaming `--no-cache` named a cause
    // that cannot have applied to a run that never executed. Only the middle
    // case is the one worth explaining; the third must not guess.
    const cases: Array<[string, boolean | undefined, RegExp]> = [
      ['hit', true, /served from cache, nothing re-ran/],
      ['exec', false, /re-executed on the same key/],
      ['unknown', undefined, /whether it re-ran is unknown/],
    ]
    for (const [label, cacheHit, expected] of cases) {
      const root = makeWorkspace(`unchanged-${label}`)
      try {
        seed(root, (cache) => {
          cache.recordRuns([
            mkRun({ hash: 'k1', project: 'p', task: 'build', runId: 'a1', startedAt: now - 2000 }),
            unknownAware(
              mkRun({
                hash: 'k1',
                project: 'p',
                task: 'build',
                runId: 'a2',
                startedAt: now - 1000,
                ...(cacheHit === true ? { status: 'cache-hit' as const } : {}),
              }),
              cacheHit,
            ),
          ])
        })
        const got = (await call(root, 'whyDidThisRerun', { runId: 'a2', taskId: 'p#build' })) as Why
        expect(got.hashChanged).toBe(false)
        expect(got.note).toMatch(expected)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })

  it('skips PAST a keyless row to find the previous run that had a key', async () => {
    // "The previous run" must mean the previous KEYED run. Pairing against a
    // `hash = ''` row instead would answer "the cache key changed" from two
    // rows where only one ever had one.
    const root = makeWorkspace('skippast')
    try {
      seed(root, (cache) => {
        cache.recordRuns([
          mkRun({ hash: 'v1', project: 'p', task: 'build', runId: 'p1', startedAt: now - 3000 }),
          mkRun({
            hash: '',
            project: 'p',
            task: 'build',
            runId: 'p2',
            status: 'skipped',
            startedAt: now - 2000,
          }),
          mkRun({ hash: 'v1', project: 'p', task: 'build', runId: 'p3', startedAt: now - 1000 }),
        ])
      })
      const got = (await call(root, 'whyDidThisRerun', { runId: 'p3', taskId: 'p#build' })) as Why
      expect(got.previousRun!.hash).toBe('v1')
      // Same key on both sides — the honest verdict is "unchanged", which is
      // only reachable by skipping the keyless row in between.
      expect(got.hashChanged).toBe(false)
      expect(got.note).toMatch(/cache key unchanged/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('answers found: false for an unknown run id without inventing a verdict', async () => {
    const got = (await call(MAIN.root, 'whyDidThisRerun', {
      runId: 'does-not-exist',
      taskId: '@t/alpha#build',
    })) as Why
    expect(got.found).toBe(false)
    expect(got.note).toMatch(/no row matching/)
    // The verdict fields are ABSENT, not null — so `'hashChanged' in result`
    // is the only safe existence check on this shape.
    expect('hashChanged' in got).toBe(false)
    expect('thisRun' in got).toBe(false)
  })

  it('answers found: false when the run exists but not for that task', async () => {
    // r3 is real; @t/beta#build did not participate in it. Matching on runId
    // alone would return another task's row under the caller's taskId.
    const got = (await call(MAIN.root, 'whyDidThisRerun', {
      runId: 'r3',
      taskId: '@t/beta#build',
    })) as Why
    expect(got.found).toBe(false)
  })

  const badArgs: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    ['a missing taskId', { runId: 'r1' }, /must be strings/],
    ['a missing runId', { taskId: '@t/alpha#build' }, /must be strings/],
    ['both missing', {}, /must be strings/],
    ['a numeric runId', { runId: 1, taskId: '@t/alpha#build' }, /must be strings/],
    ['a null taskId', { runId: 'r1', taskId: null }, /must be strings/],
    ['an array taskId', { runId: 'r1', taskId: ['a', 'b'] }, /must be strings/],
    // Reached only after the string check, so it has its own message.
    ['a taskId with no separator', { runId: 'r1', taskId: 'build' }, /"project#task"/],
  ]
  for (const [what, args, pattern] of badArgs) {
    it(`refuses ${what}`, async () => {
      await expect(call(MAIN.root, 'whyDidThisRerun', args)).rejects.toThrow(pattern)
    })
  }
})

// ---------------------------------------------------------------------------
// Empty database
// ---------------------------------------------------------------------------

describe('an empty cache answers a shaped empty', () => {
  let empty = ''
  beforeAll(() => {
    empty = makeWorkspace('empty')
  })
  afterAll(() => {
    rmSync(empty, { recursive: true, force: true })
  })

  it('every tool returns its declared shape rather than throwing', async () => {
    // A fresh clone, or a developer who has never run vx, is the FIRST thing
    // an agent meets. Throwing here reads to the model as "vx is broken".
    const stats = (await call(empty, 'getCacheStats', {})) as Stats
    expect(stats).toMatchObject({ entryCount: 0, totalBytes: 0, runCountLast24h: 0 })

    expect(await call(empty, 'getRunHistory', {})).toEqual({ runs: [], history: [] })

    const explain = (await call(empty, 'explainCacheKey', { taskId: 'a#b' })) as Explain
    expect(explain.latestEntry).toBeNull()

    const why = (await call(empty, 'whyDidThisRerun', { runId: 'r', taskId: 'a#b' })) as Why
    expect(why.found).toBe(false)
  })

  // FINDING — src/cli/mcp-rpc.ts:144.
  //
  // `runCountLast24h > 0 ? hits / runs : 0`. The guard exists because 0/0 is
  // NaN, and it chooses a confident ZERO. So an empty cache reports a 0% hit
  // rate — indistinguishable from a cache that ran a thousand tasks and hit
  // none of them, which is the one number an agent would act on by telling the
  // user their caching is misconfigured.
  //
  // This is the "Flaky tasks: 0" class from the 2026-07-27 wave: the absent
  // state and the genuinely-zero state must not render as the same value. The
  // honest answer is `null` (the sibling fields already let a careful client
  // recover it via `runCountLast24h === 0`, which is why this is a LOW).
  //
  // Encoded as the wrong-but-current 0.
  it('reports a hit rate of 0 with no runs at all (FINDING)', async () => {
    const stats = (await call(empty, 'getCacheStats', {})) as Stats
    expect(stats.runCountLast24h).toBe(0)
    expect(stats.hitRate24h).toBe(0)
    expect(stats.hitRate24h).not.toBeNull()
    // The genuinely-zero case is byte-identical, which is the problem.
    const gamma = (await call(MAIN.root, 'getCacheStats', {
      scope: { project: '@t/gamma' },
    })) as Stats
    expect(gamma.hitRate24h).toBe(stats.hitRate24h)
  })
})

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('every result survives the JSON boundary mcp.ts serializes through', () => {
  // `src/cli/mcp.ts:83` does `JSON.stringify(result, null, 2)`. A bigint there
  // throws a TypeError that surfaces as an internal error and loses the whole
  // tool call — and `runs` really does store bigint columns (wallclock ns), so
  // the only thing standing between the two is which columns the SELECT names.
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['getCacheStats', {}],
    ['getCacheStats', { scope: { project: '@t/alpha' } }],
    ['getRunHistory', { limit: 100 }],
    ['getRunHistory', { project: '@t/gamma' }],
    ['explainCacheKey', { taskId: '@t/alpha#build' }],
    ['whyDidThisRerun', { runId: 'r3', taskId: '@t/alpha#build' }],
    ['whyDidThisRerun', { runId: 'r7', taskId: '@t/gamma#lint' }],
  ]

  for (const [tool, args] of cases) {
    it(`${tool} ${JSON.stringify(args)} stringifies without throwing`, async () => {
      const result = await call(MAIN.root, tool, args)
      expect(() => JSON.stringify(result)).not.toThrow()
    })
  }

  it('no value anywhere in a result is a bigint', async () => {
    // The direct form of the same guarantee: `JSON.stringify` only throws once
    // a bigint is actually present, so this catches a bigint parked somewhere
    // the fixture happens not to populate.
    const bigints: string[] = []
    const walk = (v: unknown, at: string): void => {
      if (typeof v === 'bigint') bigints.push(at)
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`))
      else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`)
      }
    }
    for (const [tool, args] of cases) walk(await call(MAIN.root, tool, args), tool)
    expect(bigints).toEqual([])
  })

  it('a task with no executed run loses its percentile KEYS across the hop', async () => {
    // `p50DurationMs` is `number | undefined`, and JSON.stringify DELETES an
    // undefined-valued key. So the object the agent receives is a different
    // SHAPE from the one the handler returned: `'p50DurationMs' in h` is true
    // in-process and false on the wire. A client doing an `in` check to decide
    // "did we measure this?" gets opposite answers on the two sides.
    const root = makeWorkspace('hitsonly')
    try {
      seed(root, (cache) => {
        // Only cache hits: nothing ever executed, so there is no duration to
        // take a percentile of.
        cache.recordRuns([
          mkRun({
            hash: 'x1',
            project: 'onlyhits',
            task: 'build',
            status: 'cache-hit',
            cacheHit: true,
            runId: 'q1',
            startedAt: now - 2000,
          }),
          mkRun({
            hash: 'x2',
            project: 'onlyhits',
            task: 'build',
            status: 'cache-hit',
            cacheHit: true,
            runId: 'q2',
            startedAt: now - 1000,
          }),
        ])
      })
      const got = (await call(root, 'getRunHistory', {})) as History
      const entry = got.history[0]!
      expect(entry.p50DurationMs).toBeUndefined()
      expect(Object.keys(entry)).toContain('p50DurationMs')
      const hopped = JSON.parse(JSON.stringify(got)) as History
      expect(Object.keys(hopped.history[0]!)).not.toContain('p50DurationMs')
      // The rest of the aggregate is intact — only the unmeasured keys vanish.
      expect(hopped.history[0]!.runs).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the empty-key sentinel survives as an empty string, not as null', async () => {
    // A skipped row stores `hash: ''`. If the hop turned that into null the
    // `noKey` guard downstream would stop firing and the tool would resume
    // making claims about inputs it has no key for.
    const why = (await call(MAIN.root, 'whyDidThisRerun', {
      runId: 'r7',
      taskId: '@t/gamma#lint',
    })) as Why
    const hopped = JSON.parse(JSON.stringify(why)) as Why
    expect(hopped.thisRun!.hash).toBe('')
    expect(hopped.hashChanged).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The workspace context
// ---------------------------------------------------------------------------

describe('the workspace context decides which database is read', () => {
  it('honours a workspace-declared cacheDir instead of assuming .vx/cache', async () => {
    // `vx cache prune` shipped this exact bug: it hardcoded `<root>/.vx/cache`
    // and silently pruned the wrong directory for anyone who relocated their
    // cache. Here the failure would be quieter still — an agent told the
    // workspace has never run a task.
    const root = makeWorkspace('customdir')
    try {
      await Bun.write(
        path.join(root, 'vx.workspace.ts'),
        `export default { cacheDir: 'build/.vx-cache' }\n`,
      )
      const cache = new Cache(path.join(root, 'build', '.vx-cache'))
      cache.recordRun(mkRun({ hash: 'c1', project: 'custom', task: 'build', runId: 'rc' }))
      cache.close()

      const stats = (await call(root, 'getCacheStats', {})) as Stats
      expect(stats.runCountLast24h).toBe(1)
      // …and the default location was never opened.
      expect(await Bun.file(path.join(root, '.vx', 'cache', 'cache.db')).exists()).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('two contexts read two different databases', async () => {
    // The context is module-level mutable state, so a stale root is a silent
    // cross-workspace answer rather than an error.
    const other = makeWorkspace('other')
    try {
      seed(other, (cache) => {
        cache.recordRun(mkRun({ hash: 'z1', project: 'solo', task: 'build', runId: 'rz' }))
      })
      expect(((await call(MAIN.root, 'getCacheStats', {})) as Stats).runCountLast24h).toBe(6)
      expect(((await call(other, 'getCacheStats', {})) as Stats).runCountLast24h).toBe(1)
      // …and back, to prove the first read was not memoized.
      expect(((await call(MAIN.root, 'getCacheStats', {})) as Stats).runCountLast24h).toBe(6)
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  // FINDING — src/cli/mcp-rpc.ts:122.
  //
  // `new Cache(cacheDir)` CREATES the directory and an empty `cache.db`. So a
  // read-only introspection tool writes to disk, and it writes wherever the
  // agent's cwd happens to point: run `vx mcp` from the wrong place and
  // `getCacheStats` answers zeros while littering a `.vx/cache/` there.
  //
  // The zeros are the more serious half — indistinguishable from a real empty
  // cache, so an agent cannot tell it is looking at the wrong workspace.
  it('materializes a cache.db in a directory that had none (FINDING)', async () => {
    const ghost = path.join(tmpdir(), `vx-mcp-ghost-w-${Date.now()}`)
    try {
      const stats = (await call(ghost, 'getCacheStats', {})) as Stats
      expect(stats.runCountLast24h).toBe(0)
      expect(await Bun.file(path.join(ghost, '.vx', 'cache', 'cache.db')).exists()).toBe(true)
    } finally {
      rmSync(ghost, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// The real JSON-RPC transport
// ---------------------------------------------------------------------------

/**
 * `mcp.ts` owns no framing of its own — it hands stdin/stdout to the SDK's
 * `StdioServerTransport`. Re-implementing that in a test would prove nothing,
 * so these drive the REAL `bun src/bin.ts mcp` process over its real stdio.
 * One subprocess serves the whole block; each test is a message exchange.
 */
let sdkAvailable = true
try {
  await import('@modelcontextprotocol/sdk/server/index.js')
} catch {
  sdkAvailable = false
}

describe.skipIf(!sdkAvailable)('vx mcp over real stdio', () => {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined
  let pump: Promise<void> | undefined
  let buf = ''
  let closed = false
  let root = ''
  let nextId = 100

  /**
   * Accumulate stdout in the background. Deliberately NOT read-per-message:
   * the whole point of the framing tests is that a chunk boundary and a
   * message boundary are unrelated, so the reader must never assume one read
   * yields one message.
   */
  function startPump(stdout: ReadableStream<Uint8Array>): void {
    pump = (async () => {
      const dec = new TextDecoder()
      try {
        for await (const chunk of stdout) buf += dec.decode(chunk, { stream: true })
      } catch {
        // The stream tears down when the subprocess is killed in afterAll.
      }
      closed = true
    })()
  }

  /** Read one newline-delimited JSON message, or fail loudly. */
  async function readMessage(timeoutMs = 15_000): Promise<Record<string, any>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim().length > 0) return JSON.parse(line) as Record<string, any>
        continue
      }
      if (closed) throw new Error(`mcp stdio: server closed stdout; buffered=${buf}`)
      if (Date.now() > deadline) {
        throw new Error(`mcp stdio: timed out; buffered=${JSON.stringify(buf)}`)
      }
      await Bun.sleep(2)
    }
  }

  function send(raw: string): void {
    void proc!.stdin.write(raw)
    void proc!.stdin.flush()
  }

  async function rpc(method: string, params?: unknown): Promise<Record<string, any>> {
    const id = nextId++
    send(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const res = await readMessage()
    expect(res.id).toBe(id)
    return res
  }

  beforeAll(async () => {
    root = makeWorkspace('stdio')
    seed(root, (cache) => {
      cache.recordRuns([
        mkRun({ hash: 's1', project: 'wire', task: 'build', runId: 'w1', startedAt: Date.now() }),
        mkRun({
          hash: 's2',
          project: 'wire',
          task: 'build',
          runId: 'w2',
          status: 'cache-hit',
          cacheHit: true,
          startedAt: Date.now(),
        }),
        mkRun({ hash: 's3', project: 'other', task: 'build', runId: 'w3', startedAt: Date.now() }),
      ])
    })
    proc = Bun.spawn(['bun', path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'mcp'], {
      // The subprocess cannot see `setMcpContext` — it discovers its workspace
      // from cwd, which is also the path a real agent client takes.
      cwd: root,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    startPump(proc.stdout)
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'vx-test', version: '0' },
    })
    expect(init.result.protocolVersion).toBe('2025-03-26')
    send(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  }, 60_000)

  afterAll(async () => {
    proc?.kill()
    await proc?.exited
    await pump
    rmSync(root, { recursive: true, force: true })
  })

  it('identifies itself as vx at the running VERSION', async () => {
    // The handshake is the only place a client learns which build it is
    // talking to; a hardcoded version here makes every bug report wrong.
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'vx-test', version: '0' },
    })
    expect(init.result.serverInfo).toEqual({ name: 'vx', version: VERSION })
    expect(init.result.capabilities).toMatchObject({ tools: {}, resources: {} })
  })

  it('lists exactly the tools the in-process registry advertises', async () => {
    // Same two-way check as the source guard, but across the real wire — this
    // is what catches a listing handler that filters or reshapes on the way out.
    const res = await rpc('tools/list')
    const overWire = (res.result.tools as Array<{ name: string; description: string }>)
      .map((t) => t.name)
      .sort()
    expect(overWire).toEqual(
      listMcpTools()
        .map((t) => t.name)
        .sort(),
    )
    for (const t of res.result.tools as Array<{ inputSchema?: unknown }>) {
      expect(t.inputSchema).toBeDefined()
    }
  })

  it('answers both messages when two arrive in ONE chunk', async () => {
    // The transport is newline-delimited over a byte stream, so a client that
    // writes two requests back to back is ordinary. A framer that parsed only
    // the first would leave the second unanswered forever — a client hang, not
    // an error.
    const a = nextId++
    const b = nextId++
    send(
      `${JSON.stringify({ jsonrpc: '2.0', id: a, method: 'tools/list' })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: b, method: 'tools/list' })}\n`,
    )
    const first = await readMessage()
    const second = await readMessage()
    expect([first.id, second.id]).toEqual([a, b])
  })

  it('answers a message split across three chunks', async () => {
    // The inverse hazard: a framer that treats each read as a whole message
    // fails on any request larger than a pipe write. Split mid-token so a
    // naive parser cannot accidentally succeed.
    const id = nextId++
    const msg = `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'getCacheStats', arguments: { scope: { project: 'wire' } } },
    })}\n`
    send(msg.slice(0, 11))
    await Bun.sleep(20)
    send(msg.slice(11, 40))
    await Bun.sleep(20)
    send(msg.slice(40))
    const res = await readMessage()
    expect(res.id).toBe(id)
    expect(res.error).toBeUndefined()
  })

  it('forwards tool arguments, and the scope narrows over the wire too', async () => {
    // End-to-end proof that `req.params.arguments` actually reaches the
    // handler: `wire` has 2 runs of 3 in the workspace, so a dropped argument
    // shows up as 3.
    const all = await rpc('tools/call', { name: 'getCacheStats', arguments: {} })
    const scoped = await rpc('tools/call', {
      name: 'getCacheStats',
      arguments: { scope: { project: 'wire' } },
    })
    const parse = (r: Record<string, any>): Stats =>
      JSON.parse(r.result.content[0].text as string) as Stats
    expect(parse(all).runCountLast24h).toBe(3)
    expect(parse(scoped).runCountLast24h).toBe(2)
    expect(parse(scoped).scope).toEqual({ project: 'wire' })
  })

  it('returns tool results as JSON text content', async () => {
    const res = await rpc('tools/call', { name: 'getRunHistory', arguments: { limit: 2 } })
    expect(res.result.content[0].type).toBe('text')
    const payload = JSON.parse(res.result.content[0].text as string) as History
    expect(payload.runs.length).toBe(2)
  })

  it('answers an unknown JSON-RPC method with -32601, not a crash', async () => {
    const res = await rpc('no/such/method')
    expect(res.error.code).toBe(-32601)
    expect(res.result).toBeUndefined()
  })

  it('names the tool in an unknown-tool error instead of failing opaquely', async () => {
    const res = await rpc('tools/call', { name: 'runTasks', arguments: {} })
    // `runTasks` is the phantom from the header comment — the exact name a
    // model would try after reading it.
    expect(res.error.message).toMatch(/unknown tool: runTasks/)
  })

  it('reports a bad argument with its own message, never a raw SQLite error', async () => {
    // The whole point of validating at this boundary: the agent must be able
    // to read the error and fix its call.
    const res = await rpc('tools/call', {
      name: 'getCacheStats',
      arguments: { scope: 'everything' },
    })
    expect(res.error.message).toMatch(/scope must be "all" or/)
    expect(res.error.message).not.toMatch(/datatype mismatch|SQLITE/i)
  })

  it('survives a fractional limit that would be a datatype mismatch unclamped', async () => {
    const res = await rpc('tools/call', { name: 'getRunHistory', arguments: { limit: 1.9 } })
    expect(res.error).toBeUndefined()
    expect((JSON.parse(res.result.content[0].text as string) as History).runs.length).toBe(1)
  })

  it('malformed params for tools/call are refused, not dispatched', async () => {
    // `params.name` is required by the SDK's schema; a client that sends the
    // wrong envelope must get an invalid-params error rather than reaching
    // `handleMcpRequest(undefined, …)`.
    const res = await rpc('tools/call', { arguments: {} })
    expect(res.error).toBeDefined()
    expect(res.result).toBeUndefined()
  })

  it('emits NO response for a notification (a message with no id)', async () => {
    // A JSON-RPC notification must not be answered. A server that replied
    // would desynchronise every subsequent id/response pairing on the stream —
    // which is why this is checked by sending a real request afterwards and
    // requiring ITS id to come back first.
    send(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 999, reason: 'test' },
      })}\n`,
    )
    const id = nextId++
    send(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`)
    const res = await readMessage()
    expect(res.id).toBe(id)
  })

  it('keeps serving after every error above — the stream is not poisoned', async () => {
    // A long-lived agent session sends many malformed calls. If any of them
    // wedged the transport the session would die silently mid-conversation.
    const res = await rpc('tools/call', {
      name: 'explainCacheKey',
      arguments: { taskId: 'wire#build' },
    })
    expect(res.error).toBeUndefined()
    expect(JSON.parse(res.result.content[0].text as string).project).toBe('wire')
  })
})
