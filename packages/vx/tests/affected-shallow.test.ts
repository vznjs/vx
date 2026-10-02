// A base a shallow clone lacks (CI's checkout fetches one commit) is named
// as missing history, not only as a ref that did not resolve.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

it('a ref a shallow clone lacks says the clone is shallow', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-shallow-'))
  try {
    const full = path.join(dir, 'full')
    await Bun.write(path.join(full, 'a.txt'), '1\n')
    gitInitCommit(full)
    await writeFile(path.join(full, 'a.txt'), '2\n')
    gitIn(full)('commit', '-qam', 'two')
    const shallow = path.join(dir, 'shallow')
    gitIn(dir)('clone', '-q', '--depth', '1', `file://${full}`, shallow)
    const refusal = (root: string, since: string) =>
      affectedProjects({ workspaceRoot: root, since, projects: [] }).then(
        () => 'resolved',
        (err: Error) => err.message,
      )
    const hint =
      ' This clone is shallow: fetch the history the base needs (`git fetch --unshallow`, or `fetch-depth: 0` on actions/checkout).'
    expect(await refusal(shallow, 'HEAD~1')).toBe(
      `git ref "HEAD~1" did not resolve. Pass a branch or commit you have locally.${hint}`,
    )
    // CONTROL: the same missing ref in a full clone keeps the bare message.
    expect(await refusal(full, 'HEAD~2')).toBe(
      'git ref "HEAD~2" did not resolve. Pass a branch or commit you have locally.',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
