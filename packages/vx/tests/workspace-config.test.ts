// `cli/workspace-config.ts`: the `--cache-dir` flag every reading verb
// parses and where its value resolves.

import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cliCacheDir, parseCacheDirFlag } from '../src/cli/workspace-config.js'
import type { UserError } from '../src/util/index.js'

describe('parseCacheDirFlag', () => {
  it('the = form takes a value that starts with a dash; the space form refuses one', () => {
    expect(parseCacheDirFlag(['--cache-dir=-cache'], 0)).toEqual({ cacheDir: '-cache', next: 0 })
    expect(parseCacheDirFlag(['--cache-dir', '-cache'], 0)).toEqual({
      error:
        '--cache-dir requires a path (got flag -cache; a path that starts with - needs --cache-dir=-cache)',
    })
  })
})

describe('cliCacheDir', () => {
  it('resolves a relative --cache-dir against the working directory, as vx run does', async () => {
    // A directory that exists under the working directory (the suite's own).
    expect(await cliCacheDir('/nowhere', 'tests')).toBe(path.resolve(process.cwd(), 'tests'))
  })

  it('refuses a --cache-dir that is not there, by name (item 900)', async () => {
    let threw = {}
    await cliCacheDir('/nowhere', 'rel/cache').catch((err: UserError) => {
      threw = { message: err.message, code: err.code }
    })
    // A mistyped flag value is an argument mistake: VX_E_USAGE, as every
    // other flag error is, not the catch-all VX_E_REFUSED.
    expect(threw).toEqual({
      message: `--cache-dir rel/cache: no such directory (${path.resolve(process.cwd(), 'rel/cache')})`,
      code: 'VX_E_USAGE',
    })
  })
})
