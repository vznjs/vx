// `vx cache` has one subcommand, `clean`; the words other runners use for
// the rest point at the verb that answers them. `vx cache list` and `ls`
// said only "The subcommand is clean", though `vx info` reports the
// entries and `vx last --list` the runs; `gc` and `purge` are eviction.

import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { run } from './helpers/cli.js'
import { noticed } from './helpers/notice.js'

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
  const evict = '`vx cache clean` is the eviction verb (`--older-than`, `--max-size`)'
  const wipe =
    '`vx cache clean` with no bound clears the whole cache; `--older-than` / `--max-size` trim it'
  expect([await said('list'), await said('ls'), await said('gc'), await said('purge')]).toEqual([
    [1, noticed(`vx cache: unknown subcommand: list — ${runs} (see \`vx cache --help\`)\n`)],
    [1, noticed(`vx cache: unknown subcommand: ls — ${runs} (see \`vx cache --help\`)\n`)],
    [1, noticed(`vx cache: unknown subcommand: gc — ${evict} (see \`vx cache --help\`)\n`)],
    [1, noticed(`vx cache: unknown subcommand: purge — ${wipe} (see \`vx cache --help\`)\n`)],
  ])
})

it('a clean flag typed without clean names the whole clean command', async () => {
  stderr = ''
  expect([await run(['cache', '--older-than', '30d']), stderr]).toEqual([
    1,
    noticed(
      'vx cache: missing subcommand before --older-than. Did you mean `vx cache clean --older-than 30d`? (see `vx cache --help`)\n',
    ),
  ])
})

it("an Object.prototype name is a word no runner uses, not that object's source", async () => {
  // The pointer table is a plain object: `vx cache constructor` printed
  // "— function Object() { [native code] }".
  const clean = (sub: string): [number, string] => [
    1,
    noticed(
      `vx cache: unknown subcommand: ${sub}. The subcommand is clean (see \`vx cache --help\`)\n`,
    ),
  ]
  expect([await said('constructor'), await said('toString'), await said('__proto__')]).toEqual([
    clean('constructor'),
    clean('toString'),
    clean('__proto__'),
  ])
})

it('a word no runner uses still names clean (control)', async () => {
  expect(await said('bogus')).toEqual([
    1,
    noticed(
      'vx cache: unknown subcommand: bogus. Its one subcommand is `vx cache clean` (see `vx cache --help`)\n',
    ),
  ])
})
