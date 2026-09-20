// The two readings every mapper in this package shares. Both were per-file
// copies until item 446 — `relPosix` four times, the `scripts` read twice —
// and one copy of each had drifted. Neither drift was reachable in a real
// workspace; these rows exist so the next one is not either.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { packageScripts, relPosix } from '../src/paths.js'

const meta = (packageJson: unknown): ProjectMeta =>
  ({ name: 'app', dir: '/w/app', packageJson }) as unknown as ProjectMeta

describe('packageScripts — package.json is a boundary', () => {
  it('returns the map when the file holds one', () => {
    expect(packageScripts(meta({ scripts: { build: 'tsc', test: '' } }))).toEqual({
      build: 'tsc',
      test: '',
    })
  })

  it('returns {} for every shape that is not a script map', () => {
    // A string or an array is the dangerous pair: indexing one by a task
    // name is `undefined`, but by a DIGIT it is a single character, which
    // reads as a perfectly usable command. Core's `migrate-scripts.ts`
    // guards this read; this package's two copies did not.
    for (const scripts of ['build', ['build', 'test'], 42, null, true]) {
      expect([scripts, packageScripts(meta({ scripts }))]).toEqual([scripts, {}])
    }
    expect(packageScripts(meta({}))).toEqual({})
  })

  it('is what stops a digit-named task picking up a character', () => {
    // The concrete reachable difference, stated so the guard is not
    // mistaken for decoration: unguarded, this lookup is `'b'`.
    const pkg: unknown = { scripts: 'build' }
    const unguarded = (pkg as { scripts?: Record<string, unknown> }).scripts ?? {}
    expect(unguarded['0']).toBe('b')
    expect(packageScripts(meta({ scripts: 'build' }))['0']).toBeUndefined()
  })
})

describe('relPosix', () => {
  it('is POSIX-separated and matches core’s, including the empty same-dir case', () => {
    expect(relPosix('/w', '/w/app')).toBe('app')
    expect(relPosix('/w/app', '/w/lib/x')).toBe('../lib/x')
    // The copy in nx-command.ts mapped this to `.`; its only caller returns
    // early when the two are equal, so the branch never ran. Core returns
    // `''`, and that is now the one answer.
    expect(relPosix('/w/app', '/w/app')).toBe('')
  })
})
