// @vzn/vx-github — render tests (pure), plugin activation/decline, and the
// composition proof: a real `vx run` with `github({ summaryFile })` writes
// the job summary. No GitHub API involved in wave one — the summary is a
// file the Actions runner renders.
import { describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '@vzn/vx'
import type { RunContextRecord, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { localWorkspaceSource } from '../../vx/tests/helpers/local-workspace.js'
import { github, GithubSummarySink } from '../src/plugin.js'
import { renderJobSummary } from '../src/summary.js'

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
    expect(md).toContain('- **b#build** — exit 2')
    const rows = md.split('\n').filter((l) => l.startsWith('| '))
    // rows[0] header, rows[1] separator; the first DATA row is the failure
    expect(rows[2]).toContain('b#build')
  })

  it('escapes pipes in task ids — a hostile name cannot break the table', () => {
    const md = renderJobSummary(summary([task({ taskId: 'a#e|vil' })]))
    expect(md).toContain('a#e\\|vil')
  })

  it('adds the Verify column only when a verdict exists', () => {
    const md = renderJobSummary(summary([task({ verify: { kind: 'proven-complete' } })]))
    expect(md).toContain('| Verify |')
    expect(md).toContain('proven-complete')
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
      process.env = prev
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
      process.env = prev
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
      process.env = prev
    }
  })
})
