// A test for the example `commands` plugin beside it: the verb is called
// the way vx calls it, with the context vx hands it. `bun test` runs it.
import { expect, it, spyOn } from 'bun:test'
import { cacheDirVerb } from './commands.ts'

const verb = cacheDirVerb().commands!['cache-dir']!
const ctx = {
  workspaceRoot: '/ws',
  cacheDir: '/ws/.vx/cache',
  warn() {},
  concurrency: 1,
  vx: ['vx'],
  cache: {
    get: async () => null,
    put: async () => {},
    has: async () => null,
    hasMany: async () => null,
    getRun: async () => null,
  },
  artifacts: {
    save: async () => {},
    restore: async () => null,
    output: async () => null,
    share: async () => false,
    resend: async () => false,
  },
  artifactsFor: () => ({
    save: async () => {},
    restore: async () => null,
    output: async () => null,
    share: async () => false,
    resend: async () => false,
  }),
}

it('prints the cache directory; an argument is exit 2', async () => {
  const out = spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    expect(await verb.run([], ctx)).toBe(0)
    expect(out.mock.calls).toEqual([['/ws/.vx/cache\n']])
    expect(await verb.run(['x'], ctx)).toBe(2)
    // On CI the line is coloured: the words are what this asserts.
    expect(err.mock.calls.map(([l]) => Bun.stripANSI(String(l)))).toEqual([
      'vx cache-dir: takes no arguments, got x\n',
    ])
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
})
