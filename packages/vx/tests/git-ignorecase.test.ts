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
import { gitFiles } from '../src/cli/watch-filter.js'
import { listedSync } from '../src/util/git-ignored.js'
import { affectedProjects } from '../src/workspace/affected.js'
import { findProjectConfigs } from '../src/workspace/workspace.js'

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

  // `--affected` with no run beside it lists the untracked files itself.
  it('--affected selects the project a case-twin file was added to', async () => {
    const p = await setUp()
    await mkdir(path.join(root, 'q'))
    await writeFile(path.join(root, 'q/x.txt'), 'x')
    git(root, 'add', 'q')
    git(root, 'commit', '-q', '-m', 'q')
    const projects = ['p', 'q'].map((name) => ({
      name,
      dir: path.join(root, name),
      packageJson: { name } as never,
      configPath: null,
    }))
    expect([...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects }))]).toEqual(
      [path.basename(p)],
    )
  })

  // Watch's inventory, `vx lock`'s listing and discovery read what the
  // run's enumeration learned: no spawn or stat of their own.
  it("the other listings see the twin once the run's enumeration has looked", async () => {
    const p = await setUp()
    await writeFile(path.join(p, 'vx.config.mjs'), 'export default {}\n')
    git(root, 'add', 'p/vx.config.mjs')
    git(root, 'commit', '-q', '-m', 'config')
    await rm(path.join(p, 'vx.config.mjs'))
    await mkdir(path.join(root, 'P'))
    await writeFile(path.join(root, 'P/vx.config.mjs'), 'export default {}\n')
    await populateGitFilesCache(root, [p], new GitFilesCache())
    expect([
      gitFiles(root)?.listed.has(path.join(p, 'src/a.txt')),
      listedSync(root, ['p/src'])?.toSorted(),
      (await findProjectConfigs(root)).configs.map((c) => path.basename(c.dir)),
    ]).toEqual([true, ['p/src/A.txt', 'p/src/a.txt'], ['P']])
  })
})
