// `vx cache` has one subcommand, `prune`; the words other runners use for
// the rest point at the verb that answers them. `vx cache list` and `ls`
// said only "The subcommand is prune", though `vx info` reports the
// entries and `vx last --list` the runs; `gc` and `purge` are eviction.

import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { run } from '../src/cli/index.js'

let stderr = ''
beforeEach(() => {
  stderr = ''
  spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})
afterEach(() => {
  ;(process.stderr.write as unknown as { mockRestore(): void }).mockRestore()
})

const said = async (sub: string): Promise<[number, string]> => {
  stderr = ''
  return [await run(['cache', sub]), stderr]
}

it('list, ls, gc and purge name the verb that answers them', async () => {
  const runs =
    '`vx info` reports the cache entry count and size, and `vx last --list` the recent runs'
  const evict = '`vx cache prune` is the eviction verb (`--older-than`, `--max-size`)'
  expect([await said('list'), await said('ls'), await said('gc'), await said('purge')]).toEqual([
    [1, `vx cache: unknown subcommand: list — ${runs} (see \`vx cache --help\`)\n`],
    [1, `vx cache: unknown subcommand: ls — ${runs} (see \`vx cache --help\`)\n`],
    [1, `vx cache: unknown subcommand: gc — ${evict} (see \`vx cache --help\`)\n`],
    [1, `vx cache: unknown subcommand: purge — ${evict} (see \`vx cache --help\`)\n`],
  ])
})

it('a word no runner uses still names prune (control)', async () => {
  expect(await said('bogus')).toEqual([
    1,
    'vx cache: unknown subcommand: bogus. The subcommand is prune (see `vx cache --help`)\n',
  ])
})
