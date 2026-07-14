// REPRO: the loader validates exec.command/timeout/retries/resources/
// persistent but NOT exec.env. A malformed exec.env.passThrough (non-array)
// passes validation, then buildIsolatedEnv iterates it — a number/boolean
// throws "X is not iterable" mid-run; a string char-iterates silently
// (wrong behavior). Both are confusing crashes/wrongness a clear load-time
// error would prevent (the loader's stated purpose).

import { describe, expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/project-loader.js'
import { buildIsolatedEnv } from '../src/exec/env.js'

describe('REPRO: exec.env validation gap', () => {
  it('loader ACCEPTS a malformed exec.env.passThrough (number)', () => {
    expect(() =>
      validateProjectConfig(
        {
          tasks: {
            build: {
              // @ts-expect-error deliberately malformed
              exec: { command: 'echo x', env: { passThrough: 123 } },
            },
          },
        },
        'test',
      ),
    ).not.toThrow()
  })

  it('loader ACCEPTS a non-object exec.env', () => {
    expect(() =>
      validateProjectConfig(
        {
          tasks: {
            build: {
              // @ts-expect-error deliberately malformed
              exec: { command: 'echo x', env: 'not-an-object' },
            },
          },
        },
        'test',
      ),
    ).not.toThrow()
  })

  it('passThrough:number then crashes in buildIsolatedEnv (X is not iterable)', () => {
    // Exactly what taskEnv() does: step.env?.passThrough ?? []
    const step = { env: { passThrough: 123 as unknown as string[] } }
    expect(() =>
      buildIsolatedEnv({
        passThrough: step.env?.passThrough ?? [],
        define: {},
        source: process.env,
      }),
    ).toThrow(/is not iterable/)
  })

  it('passThrough:string silently CHAR-iterates (wrong env var names)', () => {
    const step = { env: { passThrough: 'FOO' as unknown as string[] } }
    const src = { F: 'fv', O: 'ov', FOO: 'correct' } as NodeJS.ProcessEnv
    const out = buildIsolatedEnv({
      passThrough: step.env?.passThrough ?? [],
      define: {},
      source: src,
    })
    // Wanted FOO=correct; instead each char 'F','O','O' was looked up.
    expect(out['FOO']).toBeUndefined()
    expect(out['F']).toBe('fv')
    expect(out['O']).toBe('ov')
  })
})
