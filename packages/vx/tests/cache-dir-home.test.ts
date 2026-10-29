// `cache.dir: '~/.cache/vx'` made a directory named `~` in the workspace:
// no shell expands `~` inside a config string or a quoted variable.
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { resolveCacheDir } from '../src/workspace/index.js'
import { restoreEnv } from './helpers/env.js'

function refusal(f: () => unknown): string {
  try {
    f()
  } catch (err) {
    return (err as Error).message
  }
  return 'NO THROW'
}

const saved = { ...process.env }
afterEach(() => restoreEnv(saved))

describe('a cache.dir under ~', () => {
  it('names the home directory, from the config and from VX_CACHE_DIR', () => {
    process.env['HOME'] = '/home/someone'
    delete process.env['VX_CACHE_DIR']
    expect(resolveCacheDir('/ws', { cache: { dir: '~/.cache/vx' } })).toBe(
      '/home/someone/.cache/vx',
    )
    process.env['VX_CACHE_DIR'] = '~/vx'
    expect(resolveCacheDir('/ws', null)).toBe('/home/someone/vx')
    // Control: a name that only starts with `~` stays in the workspace.
    delete process.env['VX_CACHE_DIR']
    expect(resolveCacheDir('/ws', { cache: { dir: '~cache' } })).toBe(path.resolve('/ws', '~cache'))
  })

  it('refuses the home directory itself, which a bare ~ named as a directory called ~ (D-153)', () => {
    process.env['HOME'] = '/home/someone'
    delete process.env['VX_CACHE_DIR']
    for (const cacheDir of ['~', '~/', '/home/someone']) {
      expect(refusal(() => resolveCacheDir('/ws', { cache: { dir: cacheDir } }))).toBe(
        `cache.dir ${JSON.stringify(cacheDir)} is the home directory itself, where the cache's \`*\` .gitignore and index would land — name a directory under it, like '~/.cache/vx'`,
      )
    }
    process.env['VX_CACHE_DIR'] = '~'
    expect(refusal(() => resolveCacheDir('/ws', null))).toBe(
      `VX_CACHE_DIR "~" is the home directory itself, where the cache's \`*\` .gitignore and index would land — name a directory under it, like '~/.cache/vx'`,
    )
    // Control: a directory under home is taken.
    delete process.env['VX_CACHE_DIR']
    expect(resolveCacheDir('/ws', { cache: { dir: '~/.vx' } })).toBe('/home/someone/.vx')
  })
})

describe('VX_CACHE_DIR of whitespace (D-160)', () => {
  it('is refused, as a whitespace cache.dir is', () => {
    // The config's `'   '` is refused (X-22); the variable made a directory
    // named three spaces at the root, hidden by the cache's own .gitignore.
    process.env['VX_CACHE_DIR'] = '   '
    expect(refusal(() => resolveCacheDir('/ws', null))).toBe(
      'VX_CACHE_DIR is only whitespace — name a directory, or unset it',
    )
    // Control: empty is unset, as documented.
    process.env['VX_CACHE_DIR'] = ''
    expect(resolveCacheDir('/ws', null)).toBe(path.resolve('/ws', '.vx', 'cache'))
  })
})

describe('a relative VX_CACHE_DIR', () => {
  // Resolved against the cwd, a run from a member made a second cache
  // there and missed every entry the root's held.
  it("is the workspace root's, whatever directory vx runs from", () => {
    process.env['VX_CACHE_DIR'] = 'mycache'
    expect(process.cwd()).not.toBe('/ws')
    expect(resolveCacheDir('/ws', null)).toBe('/ws/mycache')
  })
})
