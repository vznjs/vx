// @vzn/vx-github — render tests (pure), plugin activation/decline, and the
// composition proof: a real `vx run` with `github({ summaryFile })` writes
// the job summary. No GitHub API involved in wave one — the summary is a
// file the Actions runner renders.
import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '@vzn/vx'
import type { RunContextRecord, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { github, GithubSummarySink } from '../src/plugin.js'
import { MAX_JOB_SUMMARY_BYTES } from '../src/summary.js'
import { renderJobSummary } from '../src/summary.js'
import type { FetchFn } from '../src/checks.js'

/**
 * Put `process.env` back IN PLACE: assigning a fresh object detaches it
 * from the process environment for every later file in this process.
 */
function restoreEnv(saved: Readonly<Record<string, string | undefined>>): void {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const GITHUB_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

const RUN: RunContextRecord = {
  runId: 'run-1',
  vxVersion: '1.2.3',
  workspaceId: 'ws',
  workspaceName: 'fixture',
  command: 'vx run build',
  requestedTasks: ['build'],
  cachePolicy: 'lR,lW',
  concurrency: 4,
  flow: 'focused',
} as unknown as RunContextRecord

const task = (over: Partial<TaskTelemetry>): TaskTelemetry =>
  ({
    taskId: 'a#build',
    project: 'a',
    task: 'build',
    status: 'success',
    cacheSource: 'miss',
    exitCode: 0,
    durationMs: 1234,
    ...over,
  }) as TaskTelemetry

const summary = (
  tasks: TaskTelemetry[],
  over: Partial<RunSummaryRecord> = {},
): RunSummaryRecord => ({
  v: 2,
  run: RUN,
  startedAt: 1,
  endedAt: 2,
  totalDurationMs: 4321,
  taskCount: tasks.length,
  failedCount: tasks.filter((t) => t.status === 'failed').length,
  abortedCount: 0,
  hitCount: tasks.filter((t) => t.status.startsWith('cache-hit')).length,
  hitLocalCount: tasks.filter((t) => t.status === 'cache-hit').length,
  hitRemoteCount: tasks.filter((t) => t.status === 'cache-hit-remote').length,
  exitOk: tasks.every((t) => t.status !== 'failed'),
  tasks,
  ...over,
})

describe('renderJobSummary', () => {
  it('renders verdict, stats, and one row per task', () => {
    const md = renderJobSummary(
      summary([task({}), task({ taskId: 'a#test', task: 'test', status: 'cache-hit' })]),
    )
    expect(md).toContain('## ✅ vx run')
    expect(md).toContain('**2** tasks')
    expect(md).toContain('| a#build | ✅ ran | 1.2s |')
    expect(md).toContain('| a#test | ⚡ cache |')
    expect(md).not.toContain('### Failures')
    expect(md).not.toContain('| Verify |')
  })

  it('failures head the table and get a callout section', () => {
    const md = renderJobSummary(
      summary([task({}), task({ taskId: 'b#build', status: 'failed', exitCode: 2 })]),
    )
    expect(md).toContain('## ❌ vx run')
    expect(md).toContain('### Failures')
    expect(md).toContain('- **b#build** — exit 2\n')
    const rows = md.split('\n').filter((l) => l.startsWith('| '))
    // rows[0] header, rows[1] separator; the first DATA row is the failure
    expect(rows[2]).toContain('b#build')
  })

  it('a failure names the tasks it blocked', () => {
    const md = renderJobSummary(
      summary([
        task({ taskId: 'lib#build', status: 'failed', exitCode: 3 }),
        task({ taskId: 'app#build', status: 'skipped', exitCode: 1, blockedBy: 'lib#build' }),
        task({ taskId: 'web#build', status: 'skipped', exitCode: 1, blockedBy: 'lib#build' }),
        task({ taskId: 'x#build', status: 'skipped', exitCode: 1 }),
      ]),
    )
    expect(md).toContain('- **lib#build** — exit 3 · blocked app#build, web#build\n')
  })

  it('what failures blocked is found in one pass, however many failed', () => {
    // A scan of every task per failure: 10 000 failures of 20 000 tasks
    // rendered in 1.3 s, 35 ms grouped (F-38).
    const walks = (failures: number): number => {
      const tasks = Array.from({ length: failures }, (_, i) => [
        task({ taskId: `f${i}#build`, status: 'failed', exitCode: 1 }),
        task({ taskId: `s${i}#build`, status: 'skipped', exitCode: 1, blockedBy: `f${i}#build` }),
      ]).flat()
      const s = summary(tasks)
      let n = 0
      const counted = new Proxy(s.tasks, {
        get(target, key, receiver) {
          if (key === 'filter' || key === 'map' || key === 'forEach' || key === Symbol.iterator) n++
          return Reflect.get(target, key, receiver)
        },
      })
      const md = renderJobSummary({ ...s, tasks: counted })
      expect(md).toContain(
        `- **f${failures - 1}#build** — exit 1 · blocked s${failures - 1}#build\n`,
      )
      return n
    }
    expect(walks(50)).toBe(walks(1))
  })

  it('a persistent task that never became ready reads its reason', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#dev', status: 'failed', exitCode: 1, notReady: 'timeout' })]),
    )
    expect(md).toContain('- **b#dev** — never ready (timed out), exit 1\n')
  })

  it('a sandboxed failure counts its violations', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#build', status: 'failed', exitCode: 1, sandboxViolations: 2 })]),
    )
    expect(md).toContain('- **b#build** — exit 1 · 2 sandbox violations\n')
  })

  it('a timeout reads as the reason, not as the signal its exit is', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#build', status: 'failed', exitCode: 143, timedOut: true })]),
    )
    expect(md).toContain('- **b#build** — timed out, exit 143\n')
  })

  it('a failure above 128 names the signal its exit stands for', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'b#build', status: 'failed', exitCode: 137 })]),
    )
    expect(md).toContain('- **b#build** — exit 137 (128 + SIGKILL)\n')
  })

  it('escapes pipes in task ids — a hostile name cannot break the table', () => {
    const md = renderJobSummary(summary([task({ taskId: 'a#e|vil' })]))
    expect(md).toContain('a#e\\|vil')
  })
})

describe('github() activation', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }

  it('declines outside GitHub Actions (no GITHUB_STEP_SUMMARY, no option)', () => {
    const prev = process.env['GITHUB_STEP_SUMMARY']
    delete process.env['GITHUB_STEP_SUMMARY']
    try {
      expect(github().telemetry!(ctx)).toBeUndefined()
    } finally {
      if (prev !== undefined) process.env['GITHUB_STEP_SUMMARY'] = prev
    }
  })

  it('activates on the env var and writes via flush, not onRunSummary', async () => {
    const writes: Array<[string, string]> = []
    const sink = github({
      summaryFile: '/tmp/sumfile.md',
      checks: false,
      append: async (f, md) => void writes.push([f, md]),
    }).telemetry!(ctx) as GithubSummarySink
    expect(sink).toBeInstanceOf(GithubSummarySink)
    sink.onRunSummary!(summary([task({})]))
    expect(writes.length).toBe(0) // prompt-return contract: no I/O here
    await sink.flush!()
    expect(writes.length).toBe(1)
    expect(writes[0]![0]).toBe('/tmp/sumfile.md')
    expect(writes[0]![1]).toContain('a#build')
  })

  it('what it appends is bounded by GitHub’s 1 MiB job-summary cap', async () => {
    // The Checks payload has been clamped since it was written; the FILE was
    // not, and GitHub rejects a step summary past 1 MiB outright — so an
    // unbounded page costs the whole summary, not its tail. At the measured
    // ~55 bytes a row that is ~19 000 tasks, which this repo's own bench
    // generates (5 000 projects × four tasks), so it is reachable
    // (2026-09-20).
    const writes: string[] = []
    const sink = github({
      summaryFile: '/tmp/sumfile.md',
      checks: false,
      append: async (_f, md) => void writes.push(md),
    }).telemetry!(ctx) as GithubSummarySink
    const many = Array.from({ length: 25_000 }, (_, i) =>
      task({ taskId: `project-with-a-long-name-${i}#build` }),
    )
    sink.onRunSummary!(summary(many))
    await sink.flush!()
    expect(writes.length).toBe(1)
    const written = writes[0]!
    expect({ overCap: written.length > MAX_JOB_SUMMARY_BYTES }).toEqual({ overCap: false })
    expect(written).toContain('truncated by @vzn/vx-github')
    // The head survives: the verdict and the stats line are what a reader
    // needs, and they are rendered before the table.
    expect(written.startsWith('## ')).toBe(true)
    expect(written).toContain('**25000** tasks')
  })

  it('the cap is the step file’s: what other writers left is the room (F-42)', async () => {
    // GitHub caps the step's whole summary file; a page clamped to 1 MiB
    // after 900 KB of another tool's output made 1.9 MiB, refused whole.
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gh-sum-'))
    try {
      const run = async (already: number): Promise<{ size: number; warns: string[] }> => {
        const file = path.join(dir, `summary-${already}.md`)
        await writeFile(file, 'x'.repeat(already))
        const warns: string[] = []
        const sink = github({ summaryFile: file, checks: false }).telemetry!({
          ...ctx,
          warn: (m: string) => warns.push(m),
        }) as GithubSummarySink
        const many = Array.from({ length: 25_000 }, (_, i) =>
          task({ taskId: `project-with-a-long-name-${i}#build` }),
        )
        sink.onRunSummary!(summary(many))
        await sink.flush!()
        return { size: (await stat(file)).size, warns }
      }
      const shared = await run(900_000)
      expect(shared.size).toBeLessThanOrEqual(MAX_JOB_SUMMARY_BYTES)
      expect(shared.size).toBeGreaterThan(900_000)
      const full = await run(MAX_JOB_SUMMARY_BYTES - 10)
      expect(full.size).toBe(MAX_JOB_SUMMARY_BYTES - 10)
      expect(full.warns).toEqual([
        `vx-github: ${path.join(dir, `summary-${MAX_JOB_SUMMARY_BYTES - 10}.md`)} already holds ${MAX_JOB_SUMMARY_BYTES - 10} bytes of GitHub's 1 MiB job summary cap — no room for vx's page`,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // F-51: a step writer that left no final newline (`printf 'coverage 91%'`)
  // ran vx's heading into its paragraph. The page starts on its own line.
  it('the page starts on a new line after another writer; an empty file gets none', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gh-sum-'))
    try {
      const run = async (before: string): Promise<string> => {
        const file = path.join(dir, `s-${before.length}.md`)
        await writeFile(file, before)
        const sink = github({ summaryFile: file, checks: false }).telemetry!(
          ctx,
        ) as GithubSummarySink
        sink.onRunSummary!(summary([task({})]))
        await sink.flush!()
        return (await readFile(file, 'utf8')).split('\n').slice(0, 2).join('\n')
      }
      expect([await run('coverage 91%'), await run('')]).toEqual([
        'coverage 91%\n## ✅ vx run',
        '## ✅ vx run\n',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('CONTROL: an ordinary summary is appended whole, with no truncation tell', async () => {
    const writes: string[] = []
    const sink = github({
      summaryFile: '/tmp/sumfile.md',
      checks: false,
      append: async (_f, md) => void writes.push(md),
    }).telemetry!(ctx) as GithubSummarySink
    sink.onRunSummary!(summary([task({}), task({ taskId: 'b#build' })]))
    await sink.flush!()
    expect(writes[0]).not.toContain('truncated by @vzn/vx-github')
    expect(writes[0]).toContain('b#build')
  })

  it('a run with no summary emitted flushes to nothing', async () => {
    const writes: string[] = []
    const sink = github({
      summaryFile: '/tmp/sumfile.md',
      checks: false,
      append: async (_f, md) => void writes.push(md),
    }).telemetry!(ctx) as GithubSummarySink
    await sink.flush!()
    expect(writes.length).toBe(0)
  })
})

describe('vx run with github() — the composition proof', () => {
  it('a real run appends the job summary with the executed tasks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-run-github-'))
    try {
      const summaryFile = path.join(root, 'step-summary.md')
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'pkg'\n")
      await mkdir(path.join(root, 'pkg', 'src'), { recursive: true })
      await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
      await writeFile(path.join(root, 'pkg', 'src', 'in.txt'), 'x\n')
      await writeFile(
        path.join(root, 'pkg', 'vx.config.mjs'),
        `export default { tasks: {
           build: {
             exec: { command: 'cat src/in.txt > out.txt' },
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
           },
         } }`,
      )
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        localWorkspaceSource(
          [`github({ summaryFile: ${JSON.stringify(summaryFile)}, checks: false })`],
          `import { github } from ${JSON.stringify(GITHUB_INDEX)}\n`,
        ),
      )
      const git = (...a: string[]) => Bun.spawnSync({ cmd: ['git', ...a], cwd: root })
      git('init', '-q')
      const r = await run({
        cwd: root,
        projects: ['pkg'],
        tasks: ['build'],
        log: {
          status: () => undefined,
          error: () => undefined,
        } as never,
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      const md = await readFile(summaryFile, 'utf8')
      expect(md).toContain('## ✅ vx run')
      expect(md).toContain('pkg#build')
      expect(md).toContain('✅ ran')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Checks API', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }
  const ENV = {
    GITHUB_TOKEN: 't0ken',
    GITHUB_REPOSITORY: 'vznjs/vx',
    GITHUB_SHA: 'abc123',
  }

  it('a failed summary write still posts the check run', async () => {
    // The two outputs are independent, and the plugin already says so in one
    // direction: it declines the CHECK without a token while keeping the
    // summary. The reverse has to hold, or a full disk on the runner silently
    // costs the PR its check — the more visible of the two artifacts.
    const saved = {
      t: process.env['GITHUB_TOKEN'],
      r: process.env['GITHUB_REPOSITORY'],
      s: process.env['GITHUB_SHA'],
    }
    process.env['GITHUB_TOKEN'] = 't0ken'
    process.env['GITHUB_REPOSITORY'] = 'vznjs/vx'
    process.env['GITHUB_SHA'] = 'abc123'
    const warns: string[] = []
    const posted: string[] = []
    try {
      const sink = github({
        summaryFile: '/tmp/sumfile.md',
        append: async () => {
          throw new Error('ENOSPC: no space left on device')
        },
        fetchFn: async (url: string) => {
          posted.push(url)
          return { ok: true, status: 201, text: async () => '' }
        },
      }).telemetry!({ ...ctx, warn: (m: string) => warns.push(m) }) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
    } finally {
      for (const [k, v] of [
        ['GITHUB_TOKEN', saved.t],
        ['GITHUB_REPOSITORY', saved.r],
        ['GITHUB_SHA', saved.s],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect(posted.length).toBe(1)
    expect(warns.some((w) => w.includes('ENOSPC'))).toBe(true)
  })

  // Item 928: fetch refuses a token no header can carry and QUOTES it in the
  // error the check-run warning printed.
  it('a GITHUB_TOKEN no header can carry skips the check-run, and is not printed', async () => {
    const saved = {
      t: process.env['GITHUB_TOKEN'],
      r: process.env['GITHUB_REPOSITORY'],
      s: process.env['GITHUB_SHA'],
    }
    process.env['GITHUB_TOKEN'] = 'ghs_SECRET\nline2'
    process.env['GITHUB_REPOSITORY'] = 'vznjs/vx'
    process.env['GITHUB_SHA'] = 'abc123'
    const warns: string[] = []
    const posted: string[] = []
    try {
      const sink = github({
        summaryFile: '/tmp/sumfile.md',
        append: async () => {},
        fetchFn: async (url: string) => {
          posted.push(url)
          return { ok: true, status: 201, text: async () => '' }
        },
      }).telemetry!({ ...ctx, warn: (m: string) => warns.push(m) }) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
    } finally {
      for (const [k, v] of [
        ['GITHUB_TOKEN', saved.t],
        ['GITHUB_REPOSITORY', saved.r],
        ['GITHUB_SHA', saved.s],
      ] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    expect({ posted, warns }).toEqual({
      posted: [],
      warns: [
        'vx-github: GITHUB_TOKEN holds a line break or NUL, which no HTTP header can carry — no check-run will be created (the token is not printed)',
      ],
    })
  })

  it('resolveCheckRunEnv needs all three vars and defaults the API url', async () => {
    const { resolveCheckRunEnv } = await import('../src/checks.js')
    expect(resolveCheckRunEnv({})).toBeNull()
    expect(resolveCheckRunEnv({ ...ENV, GITHUB_TOKEN: '' })).toBeNull()
    // An EMPTY var is as absent as a missing one, and all three have to agree.
    // Only the token was checked for it, so an empty repository POSTed to
    // `/repos//check-runs` and an empty sha POSTed `head_sha: ''` — a 404 or
    // 422 warning instead of a clean decline.
    expect(resolveCheckRunEnv({ ...ENV, GITHUB_REPOSITORY: '' })).toBeNull()
    expect(resolveCheckRunEnv({ ...ENV, GITHUB_SHA: '' })).toBeNull()
    expect(resolveCheckRunEnv(ENV)).toEqual({
      token: 't0ken',
      repository: 'vznjs/vx',
      sha: 'abc123',
      apiUrl: 'https://api.github.com',
    })
    expect(resolveCheckRunEnv({ ...ENV, GITHUB_API_URL: 'https://ghe.corp/api/v3' })!.apiUrl).toBe(
      'https://ghe.corp/api/v3',
    )
    // Item 924: an empty one is absent too, not a relative URL.
    expect(resolveCheckRunEnv({ ...ENV, GITHUB_API_URL: '' })!.apiUrl).toBe(
      'https://api.github.com',
    )
  })

  // Item 924: the cut was in UTF-16 units and could split an emoji into a
  // lone surrogate; the cap is held in UTF-8 bytes, on a character boundary.
  it('the check-run clamp cuts on a character and fits the cap in bytes', async () => {
    const { clampSummary } = await import('../src/checks.js')
    for (let pad = 0; pad < 4; pad++) {
      const clamped = clampSummary('x'.repeat(pad) + '🛑'.repeat(40_000))
      expect({
        wellFormed: !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          clamped,
        ),
        replaced: clamped.includes('\uFFFD'),
        fits: Buffer.byteLength(clamped, 'utf8') <= 65_535,
        tell: clamped.endsWith('(65535-char Checks API limit)'),
      }).toEqual({ wellFormed: true, replaced: false, fits: true, tell: true })
    }
  })

  it('payload: conclusion follows exitOk; summary is the job markdown; 65535 cap holds', async () => {
    const { buildCheckRunPayload, clampSummary } = await import('../src/checks.js')
    const s = summary([task({}), task({ taskId: 'b#x', status: 'failed', exitCode: 3 })])
    const payload = buildCheckRunPayload({ summary: s, markdown: '# md', name: 'vx', sha: 'abc' })
    expect(payload['conclusion']).toBe('failure')
    expect(payload['head_sha']).toBe('abc')
    expect((payload['output'] as { title: string }).title).toBe('1 failed')
    const ok = buildCheckRunPayload({
      summary: summary([task({})]),
      markdown: 'm',
      name: 'vx',
      sha: 'a',
    })
    expect(ok['conclusion']).toBe('success')
    const clamped = clampSummary('x'.repeat(70_000))
    expect(clamped.length).toBeLessThanOrEqual(65_535)
    expect(clamped).toContain('truncated by @vzn/vx-github')
  })

  it('payload: a stopped run with nothing failed is cancelled, not a failure', async () => {
    // A cancelled CI job reaches the flush since item 849; aborted tasks are
    // not in `tasks`, so the count is the only word of them (item 851).
    const { buildCheckRunPayload } = await import('../src/checks.js')
    const stopped = buildCheckRunPayload({
      summary: summary([task({})], { exitOk: false, abortedCount: 2 }),
      markdown: 'm',
      name: 'vx',
      sha: 'a',
    })
    expect(stopped['conclusion']).toBe('cancelled')
    expect((stopped['output'] as { title: string }).title).toBe('cancelled · 2 aborted')
    // A failure beside the aborts is still a failure.
    const both = buildCheckRunPayload({
      summary: summary([task({ status: 'failed', exitCode: 1 })], { abortedCount: 2 }),
      markdown: 'm',
      name: 'vx',
      sha: 'a',
    })
    expect(both['conclusion']).toBe('failure')
    // And a failed run with no aborts and nothing failed stays a failure.
    const neither = buildCheckRunPayload({
      summary: summary([task({})], { exitOk: false }),
      markdown: 'm',
      name: 'vx',
      sha: 'a',
    })
    expect(neither['conclusion']).toBe('failure')
    const md = renderJobSummary(summary([task({})], { exitOk: false, abortedCount: 2 }))
    expect(md).toContain('## ⏹️ vx run')
    expect(md).toContain('**2** aborted')
    expect(renderJobSummary(summary([task({})], { exitOk: false }))).toContain('## ❌ vx run')
  })

  it('flush POSTs one completed check-run through the injected transport', async () => {
    const calls: Array<{ url: string; body: string; auth: string | undefined }> = []
    const prev = { ...process.env }
    Object.assign(process.env, ENV)
    try {
      const sink = github({
        summaryFile: '/tmp/sum.md',
        append: async () => undefined,
        fetchFn: async (url, init) => {
          calls.push({ url, body: init.body, auth: init.headers['authorization'] })
          return { ok: true, status: 201, text: async () => '' }
        },
      }).telemetry!(ctx) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      expect(calls.length).toBe(0) // prompt-return contract
      await sink.flush!()
      expect(calls.length).toBe(1)
      expect(calls[0]!.url).toBe('https://api.github.com/repos/vznjs/vx/check-runs')
      expect(calls[0]!.auth).toBe('Bearer t0ken')
      const body = JSON.parse(calls[0]!.body) as Record<string, unknown>
      expect(body['status']).toBe('completed')
      expect(body['conclusion']).toBe('success')
      expect((body['output'] as { summary: string }).summary).toContain('a#build')
    } finally {
      restoreEnv(prev)
    }
  })

  // Core abandons a flush at its deadline, but a request still in flight
  // kept `vx run` alive against a hanging API until the CI job's own
  // timeout (item 1055). The POST carries core's deadline signal.
  it('the check-run POST ends when core’s flush deadline aborts', async () => {
    const warns: string[] = []
    const prev = { ...process.env }
    Object.assign(process.env, ENV)
    try {
      const sink = github({
        summaryFile: '/tmp/sum.md',
        append: async () => undefined,
        fetchFn: (_url, init) =>
          // As `fetch` does: an aborted signal rejects at once, a later
          // abort when it lands; without one the request never answers.
          new Promise((_resolve, reject) => {
            if (init.signal?.aborted === true) reject(new Error('aborted'))
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      }).telemetry!({ ...ctx, warn: (m: string) => void warns.push(m) }) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      const deadline = new AbortController()
      const flushed = sink.flush!(deadline.signal)
      deadline.abort()
      await flushed
      expect(warns.length).toBe(1)
    } finally {
      restoreEnv(prev)
    }
  })

  it('a failing POST warns and never throws — observability cannot break a run', async () => {
    const warns: string[] = []
    const prev = { ...process.env }
    Object.assign(process.env, ENV)
    try {
      const sink = github({
        summaryFile: '/tmp/sum.md',
        append: async () => undefined,
        fetchFn: async () => ({ ok: false, status: 403, text: async () => 'nope' }),
      }).telemetry!({ ...ctx, warn: (m: string) => void warns.push(m) }) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!() // must resolve
      expect(warns.length).toBe(1)
      expect(warns[0]).toContain('403')
      expect(warns[0]).toContain('checks: write')
    } finally {
      restoreEnv(prev)
    }
  })

  it('checks: true without the env warns at activation; default silently skips', async () => {
    const prev = { ...process.env }
    delete process.env['GITHUB_TOKEN']
    delete process.env['GITHUB_REPOSITORY']
    delete process.env['GITHUB_SHA']
    try {
      const warns: string[] = []
      const wctx = { ...ctx, warn: (m: string) => void warns.push(m) }
      void github({ summaryFile: '/tmp/s.md', checks: true }).telemetry!(wctx)
      expect(warns.length).toBe(1)
      expect(warns[0]).toContain('no check-run will be created')
      void github({ summaryFile: '/tmp/s.md' }).telemetry!(wctx)
      expect(warns.length).toBe(1) // default: silent skip
    } finally {
      restoreEnv(prev)
    }
  })
})

// Item 806's sweep: each row fails with one line of src/ undone.
describe('every output the vx-github sweep found unheld', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }
  const ENV = { GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'vznjs/vx', GITHUB_SHA: 'abc123' }
  const row = (md: string, id: string) => md.split('\n').find((l) => l.startsWith(`| ${id} |`))

  it('the job summary is clamped in BYTES, on a character boundary', async () => {
    // Ids of 2-byte letters and a 3-byte `⚡` a row: under the cap in UTF-16
    // units, well past it in bytes, and the old clamp passed the page whole
    // (item 806).
    const { clampJobSummary } = await import('../src/summary.js')
    const many = Array.from({ length: 20_000 }, (_, i) =>
      task({ taskId: `żółć-żółć-żółć-${i}#build`, status: 'cache-hit' }),
    )
    const page = renderJobSummary(summary(many))
    expect({ units: page.length < MAX_JOB_SUMMARY_BYTES }).toEqual({ units: true })
    expect({ bytes: Buffer.byteLength(page, 'utf8') > MAX_JOB_SUMMARY_BYTES }).toEqual({
      bytes: true,
    })
    const written = clampJobSummary(page)
    expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(MAX_JOB_SUMMARY_BYTES)
    expect(written).toContain('truncated by @vzn/vx-github')
    expect(written).not.toContain('�')
  })

  it('a cut that lands inside a character backs off to its start, whichever parity', async () => {
    // 2-byte letters behind an optional 1-byte prefix: one of the two puts
    // the cut mid-character, where decoding the half left a U+FFFD that
    // also pushed the page past the cap.
    const { clampJobSummary } = await import('../src/summary.js')
    for (const prefix of ['', 'a']) {
      const written = clampJobSummary(prefix + 'ż'.repeat(MAX_JOB_SUMMARY_BYTES / 2 + 10))
      expect({
        prefix,
        replaced: written.includes('\uFFFD'),
        overCap: Buffer.byteLength(written, 'utf8') > MAX_JOB_SUMMARY_BYTES,
      }).toEqual({ prefix, replaced: false, overCap: false })
    }
  })

  it('each clamp keeps a page of exactly its cap whole and cuts one past it', async () => {
    const { clampJobSummary } = await import('../src/summary.js')
    const { clampSummary } = await import('../src/checks.js')
    const atJob = 'x'.repeat(MAX_JOB_SUMMARY_BYTES)
    expect(clampJobSummary(atJob)).toBe(atJob)
    expect(clampJobSummary(`${atJob}x`)).toContain('truncated by @vzn/vx-github')
    const atCheck = 'x'.repeat(65_535)
    expect(clampSummary(atCheck)).toBe(atCheck)
    expect(clampSummary(`${atCheck}x`)).toContain('truncated by @vzn/vx-github')
  })

  it.each([
    [999, '999ms'],
    [1000, '1.0s'],
    [59_999, '1m 0s'],
    [60_000, '1m 0s'],
    [125_000, '2m 5s'],
  ])('a duration of %d ms reads %s', (ms, shown) => {
    expect(row(renderJobSummary(summary([task({ durationMs: ms })])), 'a#build')).toBe(
      `| a#build | ✅ ran | ${shown} |`,
    )
  })

  it('a status without a label passes through as itself', () => {
    const md = renderJobSummary(summary([task({ status: 'mystery' as TaskTelemetry['status'] })]))
    expect(row(md, 'a#build')).toBe('| a#build | mystery | 1.2s |')
  })

  it('the stats line counts executed tasks, hits by source and failures, singular and plural', () => {
    const four = renderJobSummary(
      summary([
        task({ taskId: 'a#1' }),
        task({ taskId: 'a#2', status: 'failed', exitCode: 1 }),
        task({ taskId: 'a#3', status: 'cache-hit' }),
        task({ taskId: 'a#4', status: 'cache-hit-remote' }),
      ]),
    )
    expect(four.split('\n')[2]).toBe(
      '**4** tasks · **2** executed · **2** cache hits (1 remote) · **1** failed · 4.3s',
    )
    const one = renderJobSummary(summary([task({})]))
    expect(one.split('\n')[2]).toBe('**1** task · **1** executed · **0** cache hits · 4.3s')
  })

  it('a persistent task that failed to spawn reads so', () => {
    const md = renderJobSummary(
      summary([task({ status: 'failed', exitCode: 127, notReady: 'spawn' })]),
    )
    expect(md).toContain('- **a#build** — never ready (spawn failed), exit 127\n')
  })

  it('the footer counts a hit as passed and escapes the command; a blocked id is escaped', () => {
    const md = renderJobSummary(
      summary(
        [
          task({}),
          task({ taskId: 'a#test', status: 'cache-hit' }),
          task({ taskId: 'x#y', status: 'failed', exitCode: 1 }),
          task({ taskId: 'p|q#t', status: 'skipped', blockedBy: 'x#y' }),
        ],
        { run: { ...RUN, command: 'vx run a|b' } },
      ),
    )
    // Outside a table a `|` needs no escape, and `\\|` rendered literally
    // inside the code span (item 1058).
    expect(md).toContain('· `vx run a|b` · 2/4 passed · 1 restored</sub>')
    expect(md).toContain('· blocked p\\|q#t')
  })

  // A backtick in the command ended the footer's code span early, and a
  // task id's `*` rendered as emphasis (item 1058).
  it('the footer holds any command in one code span; an id is escaped as inline markdown', () => {
    const md = renderJobSummary(
      summary([task({ taskId: 'a#*x*', status: 'failed', exitCode: 1 })], {
        run: { ...RUN, command: 'vx run `echo` -- x' },
      }),
    )
    expect(md).toContain('· ``vx run `echo` -- x`` · ')
    expect(md).toContain('- **a#\\*x\\*** — exit 1')
  })

  it('the check-run payload: its times, its title in both numbers, its summary clamped', async () => {
    const { buildCheckRunPayload } = await import('../src/checks.js')
    const s = summary([task({})], { startedAt: 1_000, endedAt: 61_000 })
    const payload = buildCheckRunPayload({
      summary: s,
      markdown: 'y'.repeat(70_000),
      name: 'vx',
      sha: 'a',
    })
    expect([payload['started_at'], payload['completed_at']]).toEqual([
      '1970-01-01T00:00:01.000Z',
      '1970-01-01T00:01:01.000Z',
    ])
    const output = payload['output'] as { title: string; summary: string }
    expect(output.title).toBe('1 task · 0 cached')
    expect(output.summary.length).toBeLessThanOrEqual(65_535)
    const two = buildCheckRunPayload({
      summary: summary([task({}), task({ taskId: 'b#x', status: 'cache-hit' })]),
      markdown: 'm',
      name: 'vx',
      sha: 'a',
    })
    expect((two['output'] as { title: string }).title).toBe('2 tasks · 1 cached')
  })

  it('the POST sends exactly the API headers; a body is cut to 200 chars; an unreadable one still warns', async () => {
    const { postCheckRun } = await import('../src/checks.js')
    const env = { token: 't', repository: 'o/r', sha: 's', apiUrl: 'https://api' }
    const seen: Record<string, string>[] = []
    const warns: string[] = []
    await postCheckRun({
      env,
      payload: {},
      fetchFn: async (_url, init) => {
        seen.push(init.headers)
        return { ok: false, status: 500, text: async () => 'e'.repeat(300) }
      },
      warn: (m) => warns.push(m),
    })
    expect(seen[0]).toEqual({
      authorization: 'Bearer t',
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'vzn-vx-github',
    })
    await postCheckRun({
      env,
      payload: {},
      fetchFn: async () => ({
        ok: false,
        status: 502,
        text: async () => {
          throw new Error('socket closed')
        },
      }),
      warn: (m) => warns.push(m),
    })
    expect(warns).toEqual([
      `vx-github: check-run POST failed (500): ${'e'.repeat(200)}`,
      'vx-github: check-run POST failed (502): ',
    ])
  })

  // F-29: one 503 from GitHub cost the run its check.
  it('a 503 or a dropped connection is retried; a 400 is not', async () => {
    const { postCheckRun } = await import('../src/checks.js')
    const env = { token: 't', repository: 'o/r', sha: 's', apiUrl: 'https://api' }
    const warns: string[] = []
    const through = async (answers: (number | 'drop')[]) => {
      let calls = 0
      await postCheckRun({
        env,
        payload: {},
        fetchFn: async () => {
          const a = answers[calls++] ?? 201
          if (a === 'drop') throw new Error('connection reset')
          return { ok: a < 300, status: a, text: async () => '' }
        },
        warn: (m) => warns.push(m),
      })
      return calls
    }
    expect([await through([503]), await through(['drop']), await through([400]), warns]).toEqual([
      2,
      2,
      1,
      ['vx-github: check-run POST failed (400): '],
    ])
  })

  // F-46: the deadline passed during the wait, the next POST threw an
  // AbortError, and the warning named it instead of GitHub's 502.
  it('a deadline during the wait ends the retries and warns the 502', async () => {
    const { postCheckRun } = await import('../src/checks.js')
    const warns: string[] = []
    let calls = 0
    const deadline = new AbortController()
    setTimeout(() => deadline.abort(), 50)
    const t0 = Date.now()
    await postCheckRun({
      env: { token: 't', repository: 'o/r', sha: 's', apiUrl: 'https://api' },
      payload: {},
      fetchFn: async (_url, init) => {
        calls++
        if (init.signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
        return { ok: false, status: 502, text: async () => 'bad gateway' }
      },
      warn: (m) => warns.push(m),
      signal: deadline.signal,
    })
    expect([calls, warns]).toEqual([1, ['vx-github: check-run POST failed (502): bad gateway']])
    expect(Date.now() - t0).toBeLessThan(150)
  })

  it('a refused certificate is not retried; its message is warned (F-40)', async () => {
    const { postCheckRun } = await import('../src/checks.js')
    const warns: string[] = []
    let calls = 0
    await postCheckRun({
      env: { token: 't', repository: 'o/r', sha: 's', apiUrl: 'https://ghes' },
      payload: {},
      fetchFn: async () => {
        calls++
        throw Object.assign(new TypeError('unable to verify the first certificate'), {
          code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        })
      },
      warn: (m) => warns.push(m),
    })
    expect([calls, warns]).toEqual([
      1,
      [
        "vx-github: check-run POST failed: unable to verify the first certificate — for a host behind a private CA, set NODE_EXTRA_CA_CERTS to its CA's PEM file",
      ],
    ])
  })

  it('an empty GITHUB_STEP_SUMMARY declines like a missing one', () => {
    const prev = { ...process.env }
    process.env['GITHUB_STEP_SUMMARY'] = ''
    try {
      expect(github().telemetry!(ctx)).toBeUndefined()
    } finally {
      restoreEnv(prev)
    }
  })

  it('`checks: false` posts nothing with the env present; `checkName` and `title` are used', async () => {
    const prev = { ...process.env }
    Object.assign(process.env, ENV)
    try {
      const bodies: string[] = []
      const writes: string[] = []
      const fetchFn = async (_url: string, init: { body: string }) => {
        bodies.push(init.body)
        return { ok: true, status: 201, text: async () => '' }
      }
      const off = github({
        summaryFile: '/tmp/s.md',
        checks: false,
        append: async () => undefined,
        fetchFn,
      }).telemetry!(ctx) as GithubSummarySink
      off.onRunSummary!(summary([task({})]))
      await off.flush!()
      expect(bodies).toEqual([])
      const named = github({
        summaryFile: '/tmp/s.md',
        checkName: 'vx / ci',
        title: 'nightly',
        append: async (_f, md) => void writes.push(md),
        fetchFn,
      }).telemetry!(ctx) as GithubSummarySink
      named.onRunSummary!(summary([task({})]))
      await named.flush!()
      expect((JSON.parse(bodies[0]!) as { name: string }).name).toBe('vx / ci')
      expect(writes[0]!.startsWith('## ✅ nightly\n')).toBe(true)
    } finally {
      restoreEnv(prev)
    }
  })
})

// F-6: the mutation sweep of vx-github (147 mutants, 31 real survivors).
describe('what the F-6 sweep found unheld', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }
  const ENV = { GITHUB_TOKEN: 't0ken', GITHUB_REPOSITORY: 'vznjs/vx', GITHUB_SHA: 'abc123' }
  const durationOf = (ms: number): string =>
    renderJobSummary(summary([task({ durationMs: ms })]), 'vx run')
      .split('\n')
      .find((l) => l.startsWith('| a#build |'))!
      .split(' | ')[2]!
      .replace(' |', '')

  it('a duration rounds before it splits: 119.7 s is 2m 0s, not 1m 60s', () => {
    expect([119_700, 61_000, 3_599_600].map(durationOf)).toEqual(['2m 0s', '1m 1s', '60m 0s'])
  })

  // F-51: each tier rounded its own way, so a duration that rounds up to the
  // next tier printed in the one below: 59.96 s as `60.0s`, 999.6 ms as `1000ms`.
  it('a duration that rounds up to the next tier prints in it', () => {
    expect([59_960, 999.6, 59_940, 999.4].map(durationOf)).toEqual([
      '1m 0s',
      '1.0s',
      '59.9s',
      '999ms',
    ])
  })

  // F-51: CommonMark reads a lone CR as a line ending; the footer's code
  // span kept it, and the span broke across two lines.
  it('a CR in the command is a space in the footer, like a newline', () => {
    const md = renderJobSummary(
      summary([task({})], { run: { ...RUN, command: 'vx run a\rb\r\nc' } }),
    )
    expect(md).toContain('· `vx run a b c` · ')
  })

  it('the page ends in a newline, so a second run in the step starts its own heading', () => {
    expect(renderJobSummary(summary([task({})]), 'vx run').endsWith('\n')).toBe(true)
  })

  it('GITHUB_STEP_SUMMARY alone activates it, and is where the summary goes', async () => {
    const prev = { ...process.env }
    process.env['GITHUB_STEP_SUMMARY'] = '/tmp/from-env.md'
    const writes: string[] = []
    try {
      const sink = github({
        checks: false,
        append: async (f) => void writes.push(f),
      }).telemetry!(ctx) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
    } finally {
      restoreEnv(prev)
    }
    expect(writes).toEqual(['/tmp/from-env.md'])
  })

  it('each of the three vars missing declines the check-run', async () => {
    const { resolveCheckRunEnv } = await import('../src/checks.js')
    const without = (k: keyof typeof ENV) => {
      const e: Record<string, string> = { ...ENV }
      delete e[k]
      return resolveCheckRunEnv(e)
    }
    expect([without('GITHUB_TOKEN'), without('GITHUB_REPOSITORY'), without('GITHUB_SHA')]).toEqual([
      null,
      null,
      null,
    ])
  })

  const postWith = async (token: string, fetchFn: FetchFn): Promise<string[]> => {
    const prev = { ...process.env }
    Object.assign(process.env, ENV, { GITHUB_TOKEN: token })
    const warns: string[] = []
    try {
      const sink = github({
        summaryFile: '/tmp/sum.md',
        append: async () => undefined,
        fetchFn,
      }).telemetry!({ ...ctx, warn: (m: string) => void warns.push(m) }) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
    } finally {
      restoreEnv(prev)
    }
    return warns
  }

  it('the POST is a POST, named `vx`, on the built commit', async () => {
    const sent: Array<{ method: string; name: unknown; sha: unknown }> = []
    await postWith('t0ken', async (_url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      sent.push({ method: init.method, name: body['name'], sha: body['head_sha'] })
      return { ok: true, status: 201, text: async () => '' }
    })
    expect(sent).toEqual([{ method: 'POST', name: 'vx', sha: 'abc123' }])
  })

  it('a transport that throws warns once, naming why', async () => {
    const warns = await postWith('t0ken', async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(warns).toEqual(['vx-github: check-run POST failed: ECONNREFUSED'])
  })

  it('a token with CR, NUL or past Latin-1 is refused unprinted; a trailing newline is not', async () => {
    const posts: string[] = []
    const ok = async () => {
      posts.push('posted')
      return { ok: true, status: 201, text: async () => '' }
    }
    const refused = (fault: string) => [
      `vx-github: GITHUB_TOKEN holds ${fault}, which no HTTP header can carry — no check-run will be created (the token is not printed)`,
    ]
    expect([
      await postWith('ghs_S3CRET\rx', ok),
      await postWith('ghs_S3CRET\0x', ok),
      await postWith('ghs_S3CRET€', ok),
      await postWith('ghs_S3CRET\n', ok),
      posts,
    ]).toEqual([
      refused('a line break or NUL'),
      refused('a line break or NUL'),
      refused('a character past Latin-1'),
      [],
      ['posted'],
    ])
  })
})

// F-13: GitHub answers a rate limit with 403 as often as 429, and every
// such run was told to check its workflow's `checks: write`.
describe('a rate-limited check-run POST', () => {
  it('names the rate limit, not the permission; a plain 403 still names the permission', async () => {
    const { postCheckRun } = await import('../src/checks.js')
    const warnFor = async (status: number, body: string): Promise<string[]> => {
      const warns: string[] = []
      await postCheckRun({
        env: { token: 't', repository: 'o/r', sha: 's', apiUrl: 'https://api.test' },
        payload: {},
        fetchFn: async () => ({ ok: false, status, text: async () => body }),
        warn: (m) => void warns.push(m),
      })
      return warns
    }
    expect([
      await warnFor(403, 'You have exceeded a secondary rate limit.'),
      await warnFor(429, 'slow down'),
      await warnFor(403, 'Resource not accessible by integration'),
    ]).toEqual([
      [
        'vx-github: check-run POST failed (403) — rate-limited by GitHub; this run has no check: You have exceeded a secondary rate limit.',
      ],
      [
        'vx-github: check-run POST failed (429) — rate-limited by GitHub; this run has no check: slow down',
      ],
      [
        'vx-github: check-run POST failed (403) — does the workflow grant `permissions: checks: write`?: Resource not accessible by integration',
      ],
    ])
  })
})

// F-55: a mutation sweep of summary.ts and plugin.ts (206 mutants, 19 real
// survivors) found these unheld.
describe('the summary, as its second sweep found it unheld', () => {
  const ctx = { workspaceRoot: '/w', cacheDir: '/c', warn: () => undefined }
  const line = (md: string, prefix: string) => md.split('\n').find((l) => l.startsWith(prefix))

  it('failures beside aborts are a failed run, not a cancelled one', () => {
    const md = renderJobSummary(
      summary(
        [
          task({ status: 'failed', exitCode: 1 }),
          task({ taskId: 'b#build', status: 'aborted' as TaskTelemetry['status'] }),
        ],
        { abortedCount: 1, exitOk: false },
      ),
    )
    expect(md.split('\n')[0]).toBe('## ❌ vx run')
    // Only the failure is a Failure: the aborted task is in the table alone.
    expect(md).toContain('- **a#build** — exit 1\n')
    expect(md).not.toContain('- **b#build**')
  })

  it('violations: none says nothing, one is singular, two plural', () => {
    const failure = (sandboxViolations: number) =>
      line(
        renderJobSummary(summary([task({ status: 'failed', exitCode: 1, sandboxViolations })])),
        '- **a#build**',
      )
    expect([failure(0), failure(1), failure(2)]).toEqual([
      '- **a#build** — exit 1',
      '- **a#build** — exit 1 · 1 sandbox violation',
      '- **a#build** — exit 1 · 2 sandbox violations',
    ])
  })

  it('each task is one table row, the failures first', () => {
    const md = renderJobSummary(
      summary([
        task({}),
        task({ taskId: 'x#y', status: 'failed', exitCode: 1 }),
        task({ taskId: 'c#d' }),
      ]),
    )
    expect(md.split('\n').filter((l) => /^\| (a#build|x#y|c#d) \|/.test(l))).toEqual([
      '| x#y | ❌ failed | 1.2s |',
      '| a#build | ✅ ran | 1.2s |',
      '| c#d | ✅ ran | 1.2s |',
    ])
  })

  it('90 s reads 1m 30s', () => {
    const md = renderJobSummary(summary([task({ durationMs: 90_000 })]))
    expect(line(md, '| a#build |')).toBe('| a#build | ✅ ran | 1m 30s |')
  })

  it('every inline class is escaped in an id: in the table, a failure and a blocked id', () => {
    const id = 'a#\\`_[x]<!--'
    const esc = 'a#\\\\\\`\\_\\[x\\]\\<!--'
    const md = renderJobSummary(
      summary([
        task({ taskId: id, status: 'failed', exitCode: 1 }),
        task({ taskId: `b${id}`, status: 'skipped', blockedBy: id }),
      ]),
    )
    expect([line(md, `| ${esc} |`), line(md, `- **${esc}**`)]).toEqual([
      `| ${esc} | ❌ failed | 1.2s |`,
      `- **${esc}** — exit 1 · blocked b${esc}`,
    ])
  })

  it('a code span holds a run of backticks and one at either end', () => {
    const footer = (command: string) =>
      line(renderJobSummary(summary([task({})], { run: { ...RUN, command } })), '<sub>')!.split(
        ' · ',
      )[1]
    expect([footer('a ``b`` c'), footer('`a'), footer('a`')]).toEqual([
      '```a ``b`` c```',
      '`` `a ``',
      '`` a` ``',
    ])
  })

  it('the summaryFile option wins over GITHUB_STEP_SUMMARY', async () => {
    const prev = process.env['GITHUB_STEP_SUMMARY']
    process.env['GITHUB_STEP_SUMMARY'] = '/tmp/from-env.md'
    try {
      const files: string[] = []
      const sink = github({
        summaryFile: '/tmp/from-option.md',
        checks: false,
        append: async (f) => void files.push(f),
      }).telemetry!(ctx) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
      expect(files).toEqual(['/tmp/from-option.md'])
    } finally {
      if (prev === undefined) delete process.env['GITHUB_STEP_SUMMARY']
      else process.env['GITHUB_STEP_SUMMARY'] = prev
    }
  })

  it('after a one-byte file the page still starts on its own line', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-gh-lead-'))
    try {
      const file = path.join(dir, 's.md')
      await writeFile(file, 'x')
      const sink = github({ summaryFile: file, checks: false }).telemetry!(ctx) as GithubSummarySink
      sink.onRunSummary!(summary([task({})]))
      await sink.flush!()
      expect((await readFile(file, 'utf8')).startsWith('x\n## ✅ vx run')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
