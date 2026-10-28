// Off Actions `github()` is undefined, which `plugins` skips: no hook
// exists to run (2026-10-09). Its options are checked all the same: a typo
// passed on a laptop and failed the first CI run (2026-10-28).
import { afterEach, expect, it } from 'bun:test'
import { github } from '../src/index.js'

const saved = process.env['GITHUB_ACTIONS']
afterEach(() => {
  if (saved === undefined) delete process.env['GITHUB_ACTIONS']
  else process.env['GITHUB_ACTIONS'] = saved
})

it('off Actions the factory returns undefined, options still checked', () => {
  for (const value of [undefined, '', 'false', '1']) {
    if (value === undefined) delete process.env['GITHUB_ACTIONS']
    else process.env['GITHUB_ACTIONS'] = value
    expect(github()).toBeUndefined()
    expect(() => github({ titel: 'x' } as never)).toThrow('unknown option "titel"')
    expect(() => github({ title: '' })).toThrow(
      'github() option "title" must be a non-empty string',
    )
  }
  const { GITLAB_CI: _, ...rest } = process.env
  const gl = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import('${new URL('../src/index.ts', import.meta.url).pathname}').then((m) => m.gitlab({ cacheScop: true }))`,
    ],
    { env: rest, stderr: 'pipe' },
  )
  expect(gl.stderr.toString()).toContain('gitlab() has unknown option "cacheScop"')
})

it('on Actions it is the plugin, options checked', () => {
  process.env['GITHUB_ACTIONS'] = 'true'
  expect(Object.keys(github() ?? {}).sort()).toEqual(['commands', 'config', 'name', 'telemetry'])
  expect(() => github({ titel: 'x' } as never)).toThrow('unknown option "titel"')
})
