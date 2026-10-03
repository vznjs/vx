// A cycle is named by the first path that changed. An editor or `sed -i`
// that saves through a temporary file fires that file's event first, so
// `vx watch: app sedzCKbWc; re-running...` named a file already renamed
// away, never the config the user edited. A path still there names the
// cycle; a gone one does only when nothing that exists changed.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { ChangeJudge } from '../src/cli/watch-judge.js'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

const judgeIn = (root: string) =>
  new ChangeJudge({ workspaceRoot: root, armedAt: 0, held: () => false, uncached: () => new Set() })

it('a temporary file renamed away does not name the cycle', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-label-'))
  const config = path.join(dir, 'vx.config.mjs')
  await writeFile(config, 'export default {}\n')
  const judge = judgeIn(dir)
  judge.pending.set(path.join(dir, 'sedzCKbWc'), 'app sedzCKbWc')
  judge.pending.set(config, 'app vx.config.mjs')
  expect(judge.judge()).toBe('app vx.config.mjs')
})

// Control: a deletion alone still names the cycle.
it('a deleted file names the cycle when nothing else changed', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-label-'))
  const judge = judgeIn(dir)
  judge.pending.set(path.join(dir, 'gone.txt'), 'app gone.txt')
  expect(judge.judge()).toBe('app gone.txt')
})
