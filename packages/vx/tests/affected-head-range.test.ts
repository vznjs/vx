// Turbo's CI spelling `[origin/main...HEAD]` is the base alone: vx diffs
// from the merge base to the working tree, which holds HEAD. Any other
// range is still refused.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

it('reads <base>...HEAD as <base>, and refuses any other range', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-head-range-'))
  try {
    for (const p of ['a', 'b']) {
      await mkdir(path.join(root, 'packages', p), { recursive: true })
      await writeFile(path.join(root, 'packages', p, 'x.txt'), '1\n')
    }
    gitInitCommit(root)
    const git = gitIn(root)
    git('branch', '-M', 'main')
    git('checkout', '-q', '-b', 'feature')
    await writeFile(path.join(root, 'packages', 'a', 'x.txt'), '2\n')
    git('commit', '-qam', 'a')
    const projects = ['a', 'b'].map((name) => ({
      name,
      dir: path.join(root, 'packages', name),
      packageJson: { name } as never,
      configPath: null,
    }))
    const run = (since: string) =>
      affectedProjects({ workspaceRoot: root, since, projects }).then(
        (s) => [...s].sort(),
        (e: Error) => e.message,
      )
    expect(await run('main...HEAD')).toEqual(['a'])
    expect(await run('main...HEAD')).toEqual(await run('main'))
    // CONTROLS: a range to anything but HEAD, and a dash base behind one.
    expect(await run('main...feature')).toBe(
      'git ref "main...feature" is a range: ranges are not supported — pass the base alone ("main"); vx diffs it against the working tree.',
    )
    expect(await run('-x...HEAD')).toBe(
      'git ref "-x" is not a ref: a base cannot be empty or start with "-".',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
