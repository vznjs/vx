// scripts/api-break.ts: what counts as a break of the package API record.
import { describe, expect, it } from 'bun:test'
import { apiBreaks, contractBreaks } from '../scripts/api-break.js'

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

  it("an empty interface's first member is an addition, a changed head is not", () => {
    const empty = record(['type C (src/c.ts)', 'export interface C extends B {}'])
    const filled = record([
      'type C (src/c.ts)',
      'export interface C extends B {',
      '  on(): void',
      '}',
    ])
    expect(apiBreaks(empty, filled)).toEqual([])
    const rebased = record([
      'type C (src/c.ts)',
      'export interface C extends D {',
      '  on(): void',
      '}',
    ])
    expect(apiBreaks(empty, rebased)).toEqual([
      'type C (src/c.ts): - export interface C extends B {}',
    ])
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

describe('contractBreaks', () => {
  const j = (v: unknown): string => JSON.stringify(v, null, 2)

  it('a key added is no break; a key removed or a value changed is', () => {
    const before = j({ 'run: a task fails': 1, info: 0 })
    expect(
      contractBreaks(
        'tests/contract/exit-codes.json',
        before,
        j({ 'run: a task fails': 1, info: 0, show: 0 }),
      ),
    ).toEqual([])
    expect(
      contractBreaks('tests/contract/exit-codes.json', before, j({ 'run: a task fails': 2 })),
    ).toEqual(['- run: a task fails=1', '- info=0'])
  })

  it('a pack list or an answer key list loses a line or an item', () => {
    expect(
      contractBreaks('tests/contract/pack/vx-mcp.txt', 'a\nsrc/index.ts\n', 'a\nsrc/index.ts\nb\n'),
    ).toEqual([])
    expect(contractBreaks('tests/contract/pack/vx-mcp.txt', 'a\nsrc/index.ts\n', 'a\n')).toEqual([
      '- src/index.ts',
    ])
    expect(
      contractBreaks(
        '../vx-mcp/tests/contract/tools.json',
        j({ t: { answer: ['x', 'y'] } }),
        j({ t: { answer: ['x'] } }),
      ),
    ).toEqual(['- t.answer[]="y"'])
  })

  it('the config schema: a field or an accepted value lost is a break, a reworded refusal is not', () => {
    const before = j({
      workspace: {
        levels: { '': ['cacheDir', 'timeout'] },
        fields: { timeout: { ok: ['1'], '$CONFIG: must be a number': ['"x"'] } },
      },
    })
    const reworded = j({
      workspace: {
        levels: { '': ['cacheDir', 'timeout'] },
        fields: { timeout: { ok: ['1'], '$CONFIG: `timeout` must be a number': ['"x"'] } },
      },
    })
    expect(contractBreaks('tests/contract/config-schema.json', before, reworded)).toEqual([])
    const narrowed = j({
      workspace: {
        levels: { '': ['cacheDir'] },
        fields: { timeout: { ok: [], '$CONFIG: m': ['"x"', '1'] } },
      },
    })
    expect(contractBreaks('tests/contract/config-schema.json', before, narrowed)).toEqual([
      '- workspace.levels.[]="timeout"',
      '- workspace.fields.timeout.ok[]="1"',
    ])
  })

  it('the Turbo/Nx table: a status that got worse is a break, one that got better is not', () => {
    const rows = (s: string) => j([{ key: 'turbo.json tasks', status: s, reason: 'r' }])
    expect(
      contractBreaks('tests/contract/turbo-nx-support.json', rows('mapped'), rows('supported')),
    ).toEqual([])
    expect(
      contractBreaks(
        'tests/contract/turbo-nx-support.json',
        rows('supported'),
        rows('not-supported'),
      ),
    ).toEqual(['turbo.json tasks: supported → not-supported'])
  })

  it('a --format json schema breaks on a lost field, required entry or type, not on prose', () => {
    const schema = (o: object): string =>
      j({
        title: 'vx show --format json',
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: { type: 'string', description: 'the project' },
          description: { type: ['string', 'null'] },
        },
        ...o,
      })
    const before = schema({})
    const brk = (after: string): string[] => contractBreaks('schemas/show.json', before, after)
    // Reworded prose, and a field added, are no break.
    expect(
      brk(
        schema({
          title: 'vx show',
          required: ['name', 'description', 'root'],
          properties: {
            name: { type: 'string', description: 'its name' },
            description: { type: ['string', 'null'] },
            root: { type: 'string' },
          },
        }),
      ),
    ).toEqual([])
    // A field named like an annotation is still a field.
    expect(
      brk(schema({ properties: { name: { type: 'string', description: 'the project' } } })),
    ).toEqual([
      '- properties.description.type[]="string"',
      '- properties.description.type[]="null"',
    ])
    expect(brk(schema({ required: ['name'] }))).toEqual(['- required[]="description"'])
    expect(
      brk(
        schema({
          properties: { name: { type: 'number' }, description: { type: ['string', 'null'] } },
        }),
      ),
    ).toEqual(['- properties.name.type="string"'])
  })
})
