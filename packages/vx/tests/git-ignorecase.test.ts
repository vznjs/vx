// `core.ignorecase=true` on a filesystem that does not fold case (a `.git`
// copied from macOS to Linux): git took a new `a.txt` beside the tracked
// `A.txt` for the tracked file, so it entered no key and the run replayed a
// stale hit. vx asks the disk, not the config.

import { lstatSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GitFilesCache, populateGitFilesCache, runGitLsFiles } from '../src/cache/inputs.js'

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=test@vx.local',
      '-c',
      'user.name=vx test',
      ...args,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-ignorecase-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// Only a filesystem that tells `A.txt` from `a.txt` can hold the two files.
const folds = lstatSync(os.tmpdir().toUpperCase(), { throwIfNoEntry: false }) !== undefined

describe.skipIf(folds)('core.ignorecase on a case-sensitive filesystem', () => {
  const setUp = async (): Promise<string> => {
    const p = path.join(root, 'p')
    await mkdir(path.join(p, 'src'), { recursive: true })
    await writeFile(path.join(p, 'src/A.txt'), 'tracked')
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'initial')
    git(root, 'config', 'core.ignorecase', 'true')
    await writeFile(path.join(p, 'src/a.txt'), 'new')
    return p
  }

  it('a new file differing only in case from a tracked one is enumerated', async () => {
    const p = await setUp()
    const memo = new GitFilesCache()
    await populateGitFilesCache(root, [p], memo)
    expect(memo.snapshotFor(p, [new Bun.Glob('src/**')])).toEqual(['src/A.txt', 'src/a.txt'])
    // The new file is not git's: a clean may delete it.
    const committed = memo.committedIn(path.join(p, 'src'))
    expect([committed(path.join(p, 'src/A.txt')), committed(path.join(p, 'src/a.txt'))]).toEqual([
      true,
      false,
    ])
    // The mid-run re-enumeration of the project sees it too.
    expect(runGitLsFiles(p).files.toSorted()).toEqual(['src/A.txt', 'src/a.txt'])
  })
})
