// The machine-readable run outputs are a 1.0 contract surface
// (docs/design/versioning-1.0.md): a script reads `--dry=json` instead of
// the terminal. The plan is a hand-enumerated wire
// object (`formatPlanJson`), not a serialized type, so
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

import { describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { formatPlanJson } from '../src/cli/plan-format.js'
import type { TaskNode } from '../src/graph/index.js'
import type { PlannedTask, PlanPrediction, RunPlan } from '../src/orchestrator/plan.js'

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
      inputs: { files: [] },
      cache: { outputs: { files: [] } },
    },
    deps: [],
    requested: true,
  }
}

function fixturePlan(): Required<RunPlan> {
  const full: Required<PlannedTask> = {
    node: node('a#build', 'builds a'),
    hash: 'h1',
    cacheStatus: 'miss',
    deps: ['a#gen'],
    p50Ms: 1200,
    executor: 'vx-reapi',
    download: 'deferred',
    remoteBytes: 2048,
    affected: { kind: 'input', file: 'a/src/x.ts', project: 'a', via: ['a#gen'] },
    otherPlatform: { needs: ['darwin'], host: 'linux' },
    blockedBy: 'a#gen',
  }
  const bare: PlannedTask = { node: node('a#gen'), hash: 'h0', cacheStatus: 'hit-local', deps: [] }
  const predicted: Required<PlanPrediction> = {
    wallMs: 1,
    workMs: 2,
    unknownCount: 0,
    criticalPath: ['a#build'],
  }
  const plan: Required<RunPlan> = {
    tasks: [bare, full],
    predicted,
    unresolvedTasks: [],
    unresolvedHint: '',
    noneAffected: '',
    downloadDowngrades: [{ taskId: 'a#build', reason: 'r' }],
  }
  return plan
}

function dryJson(): unknown {
  return JSON.parse(formatPlanJson(fixturePlan()))
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
