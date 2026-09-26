// The VX_REQUIRE_* gates, made to fire (item 844). A gate is observable
// only when it fires, which on CI it never does; the laws in
// workflow-runner.unsafe.test.ts prove each is SET and FORWARDED, not that
// it would fail a run. These drive the one truthiness rule the gates share
// and the root gate itself, with the uid stubbed.
import { afterEach, describe, expect, it } from 'bun:test'
import { envFlag, restoreEnv } from './helpers/env.js'
import { skipAsRoot } from './helpers/nonroot-gate.js'

const saved = { ...process.env }
const getuid = process.getuid
afterEach(() => {
  restoreEnv(saved)
  // Absent on Windows: the stub goes rather than outliving the row.
  if (getuid === undefined) delete (process as { getuid?: unknown }).getuid
  else process.getuid = getuid
})

describe('a gate is armed by any value but empty, 0 or false', () => {
  it('reads the variable it is named for', () => {
    const table: Array<[string | undefined, boolean]> = [
      [undefined, false],
      ['', false],
      ['0', false],
      ['false', false],
      ['FALSE', false],
      ['False', false],
      ['1', true],
      ['true', true],
      ['yes', true],
      ['00', true],
    ]
    const got = table.map(([v]) => {
      if (v === undefined) delete process.env['VX_GATE_PROBE']
      else process.env['VX_GATE_PROBE'] = v
      return envFlag('VX_GATE_PROBE')
    })
    expect(got).toEqual(table.map(([, want]) => want))
    process.env['VX_GATE_PROBE'] = '1'
    expect(envFlag('VX_GATE_OTHER')).toBe(false)
  })
})

describe('the root gate', () => {
  it('as root and required, fails naming the row; as root alone, skips; not root, runs', () => {
    process.getuid = () => 0
    process.env['VX_REQUIRE_NONROOT'] = '1'
    expect(() => skipAsRoot('cache dir')).toThrow(
      'VX_REQUIRE_NONROOT is set, so this is a failure and not a skip: [cache dir] asserts',
    )
    process.env['VX_REQUIRE_NONROOT'] = '0'
    expect(skipAsRoot('cache dir')).toBe(true)
    process.getuid = () => 1000
    process.env['VX_REQUIRE_NONROOT'] = '1'
    expect(skipAsRoot('cache dir')).toBe(false)
  })
})
