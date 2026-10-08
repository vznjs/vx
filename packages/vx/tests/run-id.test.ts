// `vx last RUNID` / `vx why --run RUNID` take a run id whole or as a unique
// prefix (E-42); the e2e rows are in last.test.ts.

import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { resolveRunId, shortRunId } from '../src/orchestrator/run-id.js'

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

describe('shortRunId', () => {
  const clock = '01a0e5ca-f86b'
  it('the shortest prefix no neighbour shares, never under the 13-char clock', () => {
    const a = `${clock}-7001-aaaa`
    const b = `${clock}-7002-aaaa`
    const c = `${clock}-7002-abbb`
    const lone = '01a0e5cb-0000-7000-aaaa'
    const d = db([a, b, c, lone])
    // Each against the id sorted before it AND the one after it.
    expect([a, b, c, lone].map((id) => shortRunId(d, id))).toEqual([
      `${clock}-7001`,
      `${clock}-7002-aa`,
      `${clock}-7002-ab`,
      '01a0e5cb-0000',
    ])
    // What it prints resolves back to the run it names.
    expect([a, b, c, lone].map((id) => resolveRunId(d, shortRunId(d, id), 'vx last'))).toEqual([
      a,
      b,
      c,
      lone,
    ])
  })
})
