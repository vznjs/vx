// --affected under a config that weakens what `git diff` sees: the key
// reads the worktree's mode under `core.fileMode=false` and hashes every
// file under `core.trustctime=false` / `core.checkStat=minimal`
// (git-inputs.ts), so the diff must not trust the weaker view either.
import { chmod, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { lock } from './helpers/orchestrator.js'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

let root: string
let git: (...args: string[]) => string
let file: string
const PAST = new Date('2020-01-01T00:00:00Z')

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-affected-weak-stat-', git: false })
  for (const name of ['a', 'b']) {
    await addProject(root, name, {
      config:
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['**'] }, outputs: { files: [] }, cache: true } } }\n",
      files: { 'src/index.js': 'export {}\n' },
    })
  }
  file = path.join(root, 'packages/a/src/index.js')
  await utimes(file, PAST, PAST)
  gitInitCommit(root)
  await lock(root)
  git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'lock')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const projects = () =>
  ['a', 'b'].map((name) => ({ name, dir: path.join(root, 'packages', name), configPath: null }))

const owners = async () =>
  [...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: projects() }))].sort()

/** Git compares a ctime by the second here: wait for the file system's clock to pass the index's. */
async function nextCtimeSecond(): Promise<void> {
  const before = Math.floor((await stat(file)).ctimeMs / 1000)
  const probe = path.join(root, 'packages/a/.probe')
  for (;;) {
    await writeFile(probe, '')
    const now = Math.floor((await stat(probe)).ctimeMs / 1000)
    if (now > before) break
    await Bun.sleep(20)
  }
  await rm(probe)
}

/** Same size, mtime put back: what `cp -p` or `tar -x` leaves. */
async function rewriteKeepingStat(byRename: boolean): Promise<void> {
  if (byRename) {
    const tmp = `${file}.tmp`
    await writeFile(tmp, 'export []\n')
    await utimes(tmp, PAST, PAST)
    await rename(tmp, file)
  } else {
    await writeFile(file, 'export []\n')
    await utimes(file, PAST, PAST)
  }
}

it('a chmod +x under `core.fileMode=false` selects its project', async () => {
  git('config', 'core.fileMode', 'false')
  await chmod(file, 0o755)
  expect(await owners()).toEqual(['a'])
})

it('an in-place rewrite keeping size and mtime under `core.trustctime=false` selects its project', async () => {
  git('config', 'core.trustctime', 'false')
  await nextCtimeSecond()
  await rewriteKeepingStat(false)
  expect(await owners()).toEqual(['a'])
})

it('a rewrite keeping size and mtime under `core.checkStat=minimal` selects its project', async () => {
  git('config', 'core.checkStat', 'minimal')
  await rewriteKeepingStat(true)
  expect(await owners()).toEqual(['a'])
})

it('a ctime-only change under `core.trustctime=false` selects nothing', async () => {
  git('config', 'core.trustctime', 'false')
  await nextCtimeSecond()
  await chmod(file, 0o644)
  expect(await owners()).toEqual([])
})
