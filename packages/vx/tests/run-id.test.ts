// `vx last <id>` / `vx why --run <id>` take a run id whole or as a unique
// prefix (E-42); the e2e rows are in last.test.ts.

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { resolveRunId } from '../src/cli/run-id.js'

function db(ids: readonly string[]): Database {
  const d = new Database(':memory:')
  d.run('CREATE TABLE invocations (run_id TEXT PRIMARY KEY)')
  for (const id of ids) d.run('INSERT INTO invocations VALUES (?)', [id])
  return d
}

const refusal = (d: Database, raw: string): string => {
  try {
    resolveRunId(d, raw, 'vx last')
  } catch (err) {
    return (err as Error).message
  }
  return 'no refusal'
}

describe('resolveRunId', () => {
  it('lists five of more than five runs a prefix shares, newest first', () => {
    const d = db(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'b1'])
    expect(refusal(d, 'a')).toBe(
      'vx last: run id a is the start of more than 5 runs — type more of it:\n  a6\n  a5\n  a4\n  a3\n  a2',
    )
    // CONTROL: five runs are counted, not "more than 5".
    d.run("DELETE FROM invocations WHERE run_id = 'a6'")
    expect(refusal(d, 'a')).toBe(
      'vx last: run id a is the start of 5 runs — type more of it:\n  a5\n  a4\n  a3\n  a2\n  a1',
    )
  })

  it('a whole id, a unique prefix and an unknown id', () => {
    const d = db(['abc', 'abd', 'x'])
    expect([
      resolveRunId(d, 'abc', 'vx last'),
      resolveRunId(d, 'abd', 'vx last'),
      resolveRunId(d, 'x', 'vx last'),
      resolveRunId(d, 'zz', 'vx last'),
    ]).toEqual(['abc', 'abd', 'x', null])
  })
})
