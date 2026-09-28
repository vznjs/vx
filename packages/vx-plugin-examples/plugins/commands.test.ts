// A test for the example `commands` plugin beside it: the verb is called
// the way vx calls it, with the context vx hands it. `bun test` runs it.
import { expect, it, spyOn } from 'bun:test'
import { cacheDirVerb } from './commands.ts'

const verb = cacheDirVerb().commands!['cache-dir']!
const ctx = { workspaceRoot: '/ws', cacheDir: '/ws/.vx/cache', warn() {}, concurrency: 1 }

it('prints the cache directory; an argument is exit 2', async () => {
  const out = spyOn(console, 'log').mockImplementation(() => {})
  const err = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await verb.run([], ctx)).toBe(0)
    expect(out.mock.calls).toEqual([['/ws/.vx/cache']])
    expect(await verb.run(['x'], ctx)).toBe(2)
    expect(err.mock.calls).toEqual([['vx cache-dir: takes no arguments, got x']])
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
})
