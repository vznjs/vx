// A change the cache key sees is a change watch must see. The key reads a
// file's mode (an executable bit flips a task's output), but the watch
// judgement's settled state was a file's bytes alone: once a file had
// been judged, `chmod -x` (or `+x` after it) settled to "the same" and
// no cycle ran, so the output stood stale until the next byte edit.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

it.skipIf(process.platform === 'win32')('a mode change on a judged file is a change', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-mode-'))
  const file = path.join(dir, 'run.sh')
  await writeFile(file, '#!/bin/sh\necho hi\n')
  const judge = judgeIn(dir)
  judge.pending.set(file, 'app run.sh')
  expect(judge.judge()).toBe('app run.sh')
  await chmod(file, 0o755)
  judge.pending.set(file, 'app run.sh')
  expect(judge.judge()).toBe('app run.sh')
  await chmod(file, 0o644)
  judge.pending.set(file, 'app run.sh')
  expect(judge.judge()).toBe('app run.sh')
})

// Control: the same bytes and the same mode settle to the same state.
it('a write of the same bytes with the same mode is no change', async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-mode-'))
  const file = path.join(dir, 'run.sh')
  await writeFile(file, 'x\n')
  const judge = judgeIn(dir)
  judge.pending.set(file, 'app run.sh')
  judge.judge()
  await writeFile(file, 'x\n')
  judge.pending.set(file, 'app run.sh')
  expect(judge.judge()).toBeUndefined()
})
