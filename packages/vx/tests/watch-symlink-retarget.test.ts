// The key folds a symlink as git does, by its target string
// (`caching.md`), but the watch judgement followed the link to the bytes
// it names: a link retargeted to a file of the same bytes settled to "the
// same" and ran nothing, while the next `vx run` missed.

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

async function linked(target: string): Promise<{ judge: ChangeJudge; link: string }> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-link-'))
  await writeFile(path.join(dir, 'x1'), 'same\n')
  await writeFile(path.join(dir, 'x2'), 'same\n')
  const link = path.join(dir, 'cfg')
  await symlink(target, link)
  const judge = judgeIn(dir)
  judge.pending.set(link, 'app cfg')
  expect(judge.judge()).toBe('app cfg')
  return { judge, link }
}

it.skipIf(process.platform === 'win32')(
  'a symlink retargeted to equal bytes is a change',
  async () => {
    const { judge, link } = await linked('x1')
    await rm(link)
    await symlink('x2', link)
    judge.pending.set(link, 'app cfg')
    expect(judge.judge()).toBe('app cfg')
  },
)

// Control: a link recreated with the same target is no change.
it.skipIf(process.platform === 'win32')(
  'a symlink recreated with its target is no change',
  async () => {
    const { judge, link } = await linked('x1')
    await rm(link)
    await symlink('x1', link)
    judge.pending.set(link, 'app cfg')
    expect(judge.judge()).toBeUndefined()
  },
)
