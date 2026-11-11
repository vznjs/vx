// A file whose name is not valid UTF-8 reaches the watchers decoded, with
// U+FFFD where the bad bytes were: a name no file has. The judgement read
// it as gone, never seen, so a new or edited such input started no cycle,
// and `vx watch` sat silent where `vx run` refuses the key. macOS (APFS)
// refuses such a name outright, so the case is Linux's.

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { initialOnly, startWatch, until, useWatchFixture } from './helpers/watch-loop.js'

describe.skipIf(process.platform === 'darwin')('vx watch: a name not valid UTF-8', () => {
  const f = useWatchFixture()

  it.each([
    ['--poll', ['--all', '--poll']],
    ['the native watcher', ['--all']],
  ])(
    'made in an input tree starts a cycle that names the refusal (%s)',
    async (_mode, select) => {
      f.watch = startWatch(f.root, select)
      const w = f.watch
      await until(() => w.out().includes('watching '), 'the watching marker')
      await initialOnly(w, f.log)
      writeFileSync(
        Buffer.concat([Buffer.from(path.join(f.dir, 'src') + '/'), Buffer.from([0xff, 0x2e])]),
        'b\n',
      )
      await until(() => w.cycles() === 1, 'the cycle for the new file')
      await until(
        () => (w.out() + w.err()).includes('not valid UTF-8'),
        'the run refusing the name',
      )
      expect(w.cycles()).toBe(1)
    },
    40_000,
  )
})
