// What an outcome becomes on the way out: the `runs` rows, the telemetry
// `task.end` body and the event stream's view. TaskOutcome is in-process
// and may change shape; these three are stored or on a wire and may not
// (TELEMETRY_SCHEMA_VERSION, the history schema). One outcome per status,
// every field set somewhere, projected through all three and held to
// tests/contract/outcome-projection.json.
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-outcome-projection.test.ts, then oxfmt the file
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import type { TaskOutcome } from '../src/graph/outcome.js'
import type { TaskNode } from '../src/graph/task-graph.js'
import { assembleRunRecords } from '../src/orchestrator/run-records.js'
import { projectOutcome } from '../src/report/events.js'

const CONTRACT = path.join(import.meta.dir, 'contract', 'outcome-projection.json')

function node(id: string): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: `/ws/${projectName}`,
    taskName,
    config: { exec: { command: 'noop' }, cache: true },
    deps: [],
    requested: true,
  } as TaskNode
}

const OUTCOMES: TaskOutcome[] = [
  {
    node: node('a#build'),
    status: 'success',
    exitCode: 0,
    durationMs: 120,
    hash: 'h-build',
    timing: {
      queuedMs: 4,
      admissionHeldMs: 2,
      startNs: 1_000_000n,
      endNs: 121_000_000n,
      saveMs: 6,
    },
    usage: { cpuMs: 90, peakRssBytes: 4096, peakCores: 1.5, avgRssBytes: 2048 },
    cache: {
      saved: true,
      inputFiles: 12,
      artifactBytes: 300,
      outputBytes: 900,
      inputChanges: { count: 1, first: [{ kind: 'file', name: 'src/a.ts', change: 'changed' }] },
    },
    attempts: { count: 2, flaky: { passes: 1, failures: 1 } },
    placement: { where: 'worker-1', cores: 8, memoryBytes: 1024, cpuShare: 0.5 },
  },
  {
    node: node('a#lint'),
    status: 'cache-hit-remote',
    exitCode: 0,
    durationMs: 9,
    hash: 'h-lint',
    timing: { fetchMs: 7, startNs: 2_000_000n, endNs: 11_000_000n },
    cache: {
      restored: true,
      stored: { durationMs: 900, cpuMs: 800, peakRssBytes: 700 },
      artifactBytes: 50,
      outputBytes: 70,
    },
  },
  {
    node: node('a#types'),
    status: 'cache-hit',
    exitCode: 0,
    durationMs: 1,
    hash: 'h-types',
    cache: { restored: false, deferred: true },
  },
  {
    node: node('b#test'),
    status: 'failed',
    exitCode: 1,
    durationMs: 300,
    hash: 'h-test',
    timedOut: true,
    failedOutput: 'out',
    inputMoved: 'b/x.ts',
    timing: { startNs: 3_000_000n, endNs: 303_000_000n },
    attempts: { count: 2, failed: [{ endedAt: 5, exitCode: 1 }], outputs: ['first'] },
    sandbox: { violations: 1, lines: ['deny file-read /etc'], fix: { read: ['/etc'] } },
    cache: { unkeyed: true, driftedInput: '/ws/b/x.ts', keylessBy: 'b#gen' },
  },
  {
    node: node('b#serve'),
    status: 'failed',
    exitCode: 1,
    durationMs: 50,
    notReady: 'timeout',
    placement: { carried: true },
  },
  {
    node: node('b#restore'),
    status: 'failed',
    exitCode: 1,
    durationMs: 3,
    hash: 'h-restore',
    restoreFailed: true,
  },
  {
    node: node('c#e2e'),
    status: 'aborted',
    exitCode: 130,
    durationMs: 40,
    hash: 'h-e2e',
    timing: { startNs: 4_000_000n, endNs: 44_000_000n },
    taintedBy: 'b#test',
  },
  { node: node('c#deploy'), status: 'aborted', exitCode: 1, durationMs: 0, blockedBy: 'b#test' },
  { node: node('c#docs'), status: 'skipped', durationMs: 0, blockedBy: 'b#test' },
  {
    node: node('c#mac'),
    status: 'skipped',
    durationMs: 0,
    platform: true,
    otherPlatform: { needs: ['darwin'], host: 'linux' },
  },
  { node: node('c#off'), status: 'success', exitCode: 0, durationMs: 5, cache: { off: true } },
  // Fail-fast stopped it after its key was derived: the key stays on the row.
  {
    node: node('d#unbegun'),
    status: 'skipped',
    durationMs: 0,
    hash: 'h-unbegun',
    timing: { startNs: 5_000_000n, endNs: 6_000_000n },
  },
]

/** bigint as its decimal string: the JSON the wire and the rows already use. */
const json = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x), 2) + '\n'

it('runs rows, task.end bodies and event views stay what they were', () => {
  const { runs, telemetryTasks } = assembleRunRecords({
    outcomes: OUTCOMES,
    runId: 'run-1',
    startedAtMs: 1_000_000,
    endedAtMs: 1_005_000,
    totalMs: 5000,
    ok: false,
    command: 'vx run build',
    requestedTasks: ['build'],
    cachePolicy: 'rw',
    concurrency: 3,
    flow: 'focused',
    git: { commitSha: 'abc123', branch: 'main', dirty: true },
    ci: { ci: true, provider: 'github' },
    host: { host: 'box', os: 'linux', arch: 'x64' },
    withTelemetry: true,
  })
  const views = OUTCOMES.map((o) => {
    const v = projectOutcome(o)
    // Wall-clock stamps are taken when it projects.
    return { ...v, startedAt: 0, endedAt: 0 }
  })
  const want = json({ runs, telemetryTasks, views })
  if (process.env['VX_UPDATE_CONTRACT'] === '1') writeFileSync(CONTRACT, want)
  // Parsed: oxfmt lays the file out, and every value is a JSON string or number.
  expect(JSON.parse(want)).toEqual(JSON.parse(readFileSync(CONTRACT, 'utf8')))
})
