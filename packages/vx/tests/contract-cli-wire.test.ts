// The machine-readable run outputs are a 1.0 contract surface
// (docs/design/versioning-1.0.md): a script reads `--dry=json` and the
// `--summarize` file instead of the terminal. Both are hand-enumerated wire
// objects (`formatPlanJson`, `writeRunSummary`), not a serialized type, so
// the type pin (contract-package-api.test.ts) does not hold them: a renamed
// key there passed every test. This file renders each from a fixture that
// sets every field its source type has (`Required<…>`, so a new field must
// be given a value here before this compiles), records the wire's shape
// (every key path and the JSON types seen at it), and compares it with
// `tests/contract/cli-wire.json`. The samples docs/cli.md prints are held
// to the same shape: a key the page shows must be one the wire has.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-cli-wire.test.ts

import { afterAll, describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatPlanJson } from '../src/cli/plan-format.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import type { FlakyFinding } from '../src/orchestrator/failure-mode.js'
import type { PlannedTask, PlanPrediction, RunPlan } from '../src/orchestrator/plan.js'
import { writeRunSummary } from '../src/orchestrator/run-artifacts.js'

const RECORD = path.join(import.meta.dir, 'contract', 'cli-wire.json')
const CLI_DOC = path.resolve(import.meta.dir, '..', 'docs', 'cli.md')

/** Key path → the sorted JSON types seen there (`tasks[].id` → `string`). */
type Shape = Record<string, string>

function shapeOf(value: unknown, at = '', out: Record<string, Set<string>> = {}): typeof out {
  const add = (t: string): void => void (out[at] ??= new Set()).add(t)
  if (value === null) add('null')
  else if (Array.isArray(value)) {
    add('array')
    for (const v of value) shapeOf(v, `${at}[]`, out)
  } else if (typeof value === 'object') {
    add('object')
    for (const [k, v] of Object.entries(value)) shapeOf(v, at === '' ? k : `${at}.${k}`, out)
  } else add(typeof value)
  return out
}

const flatten = (s: Record<string, Set<string>>): Shape =>
  Object.fromEntries(
    Object.entries(s)
      .filter(([k]) => k !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, ts]) => [k, [...ts].sort().join(' | ')]),
  )

function node(id: string, description?: string): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    projectDir: `/ws/${projectName}`,
    taskName,
    config: {
      ...(description !== undefined ? { description } : {}),
      exec: { command: 'true' },
      cache: { inputs: { files: [] }, outputs: { files: [] } },
    },
    deps: [],
    requested: true,
  }
}

function dryJson(): unknown {
  const full: Required<PlannedTask> = {
    node: node('a#build', 'builds a'),
    hash: 'h1',
    cacheStatus: 'miss',
    deps: ['a#gen'],
    p50Ms: 1200,
    executor: 'vx-reapi',
    download: 'deferred',
  }
  const bare: PlannedTask = { node: node('a#gen'), hash: 'h0', cacheStatus: 'hit-local', deps: [] }
  const predicted: Required<PlanPrediction> = { wallMs: 1, workMs: 2, unknownCount: 0 }
  const plan: Required<RunPlan> = {
    tasks: [bare, full],
    predicted,
    unresolvedTasks: [],
    downloadDowngrades: [{ taskId: 'a#build', reason: 'r' }],
  }
  return JSON.parse(formatPlanJson(plan))
}

const scratch: string[] = []
afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })))
})

async function summarizeJson(): Promise<unknown> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-wire-'))
  scratch.push(dir)
  const full: Required<TaskOutcome> = {
    node: { ...node('a#build'), config: { exec: { command: 'true' } } },
    status: 'failed',
    exitCode: 1,
    durationMs: 10,
    hash: 'h1',
    storedDurationMs: 9,
    storedCpuMs: 8,
    storedPeakRssBytes: 7,
    admissionHeldMs: 6,
    cpuMs: 5,
    peakRssBytes: 4,
    groupUpstream: [],
    unkeyed: true,
    blockedBy: 'a#gen',
    timedOut: true,
    notReady: 'timeout',
    where: 'remote',
    outputs: 'deferred',
    wallclockStartNs: 1n,
    wallclockEndNs: 2n,
    restored: false,
    attempts: 2,
    sandboxViolations: 3,
    sandboxViolationLines: ['deny file-read /x'],
  }
  const flaky: FlakyFinding = {
    taskId: 'a#build',
    project: 'a',
    task: 'build',
    hash: 'h1',
    status: 'failed',
    attempts: 2,
    passes: 1,
    failures: 1,
  }
  const bare: TaskOutcome = { node: node('a#gen'), status: 'success', exitCode: 0, durationMs: 1 }
  const aborted = (id: string, hash?: string): TaskOutcome => ({
    node: node(id),
    status: 'aborted',
    exitCode: 130,
    durationMs: 1,
    ...(hash !== undefined ? { hash } : {}),
  })
  const file = await writeRunSummary({
    target: path.join(dir, 'summary.json'),
    cacheDir: dir,
    cwd: dir,
    runId: 'r',
    startedAtMs: 0,
    endedAtMs: 1,
    totalMs: 1,
    ok: false,
    outcomes: [bare, full, aborted('a#x'), aborted('a#y', 'h2')],
    flaky: [flaky],
  })
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The ```json block that follows `marker` in docs/cli.md. */
function docSample(marker: string): unknown {
  const doc = readFileSync(CLI_DOC, 'utf8')
  const at = doc.indexOf(marker)
  expect({ marker, found: at !== -1 }).toEqual({ marker, found: true })
  const block = /```json\n([\s\S]*?)```/.exec(doc.slice(at))!
  return JSON.parse(block[1]!)
}

describe('the machine-readable run outputs (versioning-1.0.md)', () => {
  it('agree with tests/contract/cli-wire.json', async () => {
    const live = {
      'dry=json': flatten(shapeOf(dryJson())),
      summarize: flatten(shapeOf(await summarizeJson())),
    }
    if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
      writeFileSync(RECORD, JSON.stringify(live, null, 2) + '\n')
    }
    // On a failure, the diff below IS the wire change: regenerate the record
    // (header) only if the change is meant to ship, and say so in the
    // release notes.
    expect(live).toEqual(JSON.parse(readFileSync(RECORD, 'utf8')))
  })

  it('docs/cli.md shows only keys the wire has, with the types it has', async () => {
    const cases: Array<[string, unknown, unknown]> = [
      [
        '`--dry=json` emits the same data',
        docSample('`--dry=json` emits the same data'),
        dryJson(),
      ],
      [
        '### `--summarize[=<path>]`',
        docSample('### `--summarize[=<path>]`'),
        await summarizeJson(),
      ],
    ]
    for (const [marker, sample, wire] of cases) {
      const live = flatten(shapeOf(wire))
      const shown = flatten(shapeOf(sample))
      const wrong = Object.entries(shown).filter(
        ([k, t]) => live[k] === undefined || !t.split(' | ').every((x) => live[k]!.includes(x)),
      )
      expect({ marker, wrong }).toEqual({ marker, wrong: [] })
    }
  })
})
