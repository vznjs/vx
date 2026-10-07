// The check run vx-ci posts is a 1.0 contract surface (docs/design/
// versioning-1.0.md): a branch protection rule requires a check BY NAME,
// and automation reads its conclusion, so a renamed check or a changed
// conclusion breaks a repo's merges as surely as a renamed export. The
// plugin is driven with its defaults, on a GitHub Actions environment,
// through a passing, a failing and a cancelled run; each POST is captured
// and its endpoint, method, header names, body keys and the values a rule
// or script keys on (name, status, conclusion) are compared with
// `tests/contract/checks.txt`. Times and the markdown are not recorded. A
// lost line is a break the break law sees.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-checks.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { RunContextRecord, RunSummaryRecord, TaskTelemetry } from '@vzn/vx'
import { github } from '../src/plugin.js'
import type { GithubSummarySink } from '../src/sink.js'

const RECORD = path.join(import.meta.dir, 'contract', 'checks.txt')
const ENV = {
  GITHUB_TOKEN: 't0ken',
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_SHA: 'abc123',
  GITHUB_API_URL: undefined,
}
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const RUN = { runId: 'r', vxVersion: '1.0.0', command: 'vx run build' } as RunContextRecord
const task = (status: TaskTelemetry['status']): TaskTelemetry => ({
  taskId: 'a#build',
  project: 'a',
  task: 'build',
  status,
  cacheSource: 'miss',
  exitCode: status === 'failed' ? 1 : 0,
  durationMs: 10,
})
const summary = (t: TaskTelemetry, counts: Partial<RunSummaryRecord>): RunSummaryRecord => ({
  v: 3,
  run: RUN,
  startedAt: 0,
  endedAt: 10,
  totalDurationMs: 10,
  taskCount: 1,
  failedCount: 0,
  abortedCount: 0,
  hitCount: 0,
  hitLocalCount: 0,
  hitRemoteCount: 0,
  upToDateCount: 0,
  restoredLocalCount: 0,
  restoredRemoteCount: 0,
  exitOk: true,
  tasks: [t],
  ...counts,
})
const OUTCOMES: ReadonlyArray<readonly [string, RunSummaryRecord]> = [
  ['a passing run', summary(task('success'), {})],
  ['a failing run', summary(task('failed'), { exitOk: false, failedCount: 1 })],
  ['a cancelled run', summary(task('aborted'), { exitOk: false, abortedCount: 1 })],
]

/** One `path: type` line per leaf, or `path = value` where the value is the contract. */
function shape(v: unknown, at: string, out: string[], values: ReadonlySet<string>): void {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) shape(x, at === '' ? k : `${at}.${k}`, out, values)
  } else out.push(values.has(at) ? `${at} = ${JSON.stringify(v)}` : `${at}: ${typeof v}`)
}

it('the check run vx-ci posts is shaped as tests/contract/checks.txt records', async () => {
  const lines: string[] = []
  for (const [name, record] of OUTCOMES) {
    const posts: {
      url: string
      init: { method?: string; headers?: Record<string, string>; body?: string }
    }[] = []
    const sink = github({
      summaryFile: '/dev/null',
      append: async () => {},
      fetchFn: async (url, init) => {
        posts.push({ url, init: init as (typeof posts)[number]['init'] })
        return { ok: true, status: 201, text: async () => '' }
      },
    }).telemetry!({
      workspaceRoot: '/w',
      cacheDir: '/c',
      warn: () => undefined,
    }) as GithubSummarySink
    sink.onRunSummary(record)
    await sink.flush()
    expect(posts.length).toBe(1)
    const [post] = posts
    lines.push(`${name}: ${post!.init.method} ${post!.url}`)
    for (const h of Object.keys(post!.init.headers ?? {}).sort()) lines.push(`${name}: header ${h}`)
    const body: string[] = []
    shape(
      JSON.parse(post!.init.body!),
      '',
      body,
      new Set(['name', 'status', 'conclusion', 'head_sha']),
    )
    for (const l of body.sort()) lines.push(`${name}: ${l}`)
  }
  const text = lines.join('\n') + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
})
