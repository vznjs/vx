// scripts/api-break.ts: what counts as a break of the package API record.
import { describe, expect, it } from 'bun:test'
import { apiBreaks } from '../scripts/api-break.js'

const record = (...sections: [string, ...string[]][]): string =>
  sections.map(([id, ...lines]) => [`== ${id}`, ...lines].join('\n')).join('\n') + '\n'

const before = record(
  [
    'type TaskExecutor (src/exec/executor.ts)',
    'export interface TaskExecutor {',
    '  readonly name: string',
    '}',
  ],
  [
    'function run (src/orchestrator/run.ts)',
    'export async function run(options: RunOptions): Promise<RunSummary>',
  ],
)

describe('apiBreaks', () => {
  it('an addition is not a break: a new section, a new member', () => {
    const after = record(
      [
        'type TaskExecutor (src/exec/executor.ts)',
        'export interface TaskExecutor {',
        '  readonly name: string',
        '  readonly remote?: boolean',
        '}',
      ],
      [
        'function run (src/orchestrator/run.ts)',
        'export async function run(options: RunOptions): Promise<RunSummary>',
      ],
      [
        'function planRun (src/orchestrator/plan.ts)',
        'export async function planRun(o: PlanOptions): Promise<RunPlan>',
      ],
    )
    expect(apiBreaks(before, after)).toEqual([])
    expect(apiBreaks(before, before)).toEqual([])
  })

  it('a removed export, a removed member and a changed signature each are', () => {
    const after = record([
      'type TaskExecutor (src/exec/executor.ts)',
      'export interface TaskExecutor {',
      '}',
    ])
    expect(apiBreaks(before, after)).toEqual([
      'type TaskExecutor (src/exec/executor.ts): - readonly name: string',
      'removed function run (src/orchestrator/run.ts)',
    ])
    const changed = record(
      [
        'type TaskExecutor (src/exec/executor.ts)',
        'export interface TaskExecutor {',
        '  readonly name: string',
        '}',
      ],
      [
        'function run (src/orchestrator/run.ts)',
        'export async function run(options: RunOptions, extra: number): Promise<RunSummary>',
      ],
    )
    expect(apiBreaks(before, changed)).toEqual([
      'function run (src/orchestrator/run.ts): - export async function run(options: RunOptions): Promise<RunSummary>',
    ])
  })
})
