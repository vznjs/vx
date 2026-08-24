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
import { localWorkspaceSource } from '../../../tests/helpers/local-workspace.js'
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
          [`github({ summaryFile: ${JSON.stringify(summaryFile)} })`],
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
