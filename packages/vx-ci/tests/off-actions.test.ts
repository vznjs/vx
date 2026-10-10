// Off Actions `github()` is undefined, which `plugins` skips: no option is
// checked and no hook exists to run (owner, 2026-10-09).
import { afterEach, expect, it } from 'bun:test'
import { github } from '../src/index.js'

const saved = process.env['GITHUB_ACTIONS']
afterEach(() => {
  if (saved === undefined) delete process.env['GITHUB_ACTIONS']
  else process.env['GITHUB_ACTIONS'] = saved
})

it('off Actions the factory returns undefined, options unchecked', () => {
  for (const value of [undefined, '', 'false', '1']) {
    if (value === undefined) delete process.env['GITHUB_ACTIONS']
    else process.env['GITHUB_ACTIONS'] = value
    expect(github()).toBeUndefined()
    expect(github({ titel: 'x' } as never)).toBeUndefined()
  }
})

it('on Actions it is the plugin, options checked', () => {
  process.env['GITHUB_ACTIONS'] = 'true'
  expect(Object.keys(github() ?? {}).sort()).toEqual(['config', 'name', 'telemetry'])
  expect(() => github({ titel: 'x' } as never)).toThrow('unknown option "titel"')
})
