// `cacheDir: '~/.cache/vx'` made a directory named `~` in the workspace:
// no shell expands `~` inside a config string or a quoted variable.
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { resolveCacheDir } from '../src/workspace/index.js'
import { restoreEnv } from './helpers/env.js'

const saved = { ...process.env }
afterEach(() => restoreEnv(saved))

describe('a cacheDir under ~', () => {
  it('names the home directory, from the config and from VX_CACHE_DIR', () => {
    process.env['HOME'] = '/home/someone'
    delete process.env['VX_CACHE_DIR']
    expect(resolveCacheDir('/ws', { cacheDir: '~/.cache/vx' })).toBe('/home/someone/.cache/vx')
    process.env['VX_CACHE_DIR'] = '~/vx'
    expect(resolveCacheDir('/ws', null)).toBe('/home/someone/vx')
    // Control: a name that only starts with `~` stays in the workspace.
    expect(resolveCacheDir('/ws', { cacheDir: '~cache' })).toBe(path.resolve('/ws', '~cache'))
  })
})
