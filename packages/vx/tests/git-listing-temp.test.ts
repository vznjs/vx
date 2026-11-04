// The git listing goes to a file in a `vx-git-*` temp directory, removed in
// a `finally`. A run stopped while git listed (a Ctrl-C before the run's
// signal handlers are up, or a kill) ran no `finally`, and each stop left
// two directories behind. The directory now goes the moment the file is
// open; the run reads the listing through its descriptor.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { lock } from './helpers/orchestrator.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
let tmp: string
let shim: string
let pids: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-git-listing-' })
  await addProject(root, 'a', {
    config: `export default { tasks: { build: { exec: { command: 'true' } } } }`,
  })
  await lock(root)
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-listing-tmp-'))
  shim = path.join(root, '.shim')
  pids = path.join(shim, 'pids')
  await mkdir(shim)
  // A listing that takes its time: the shim says it started, then waits.
  await writeFile(
    path.join(shim, 'git'),
    `#!/bin/sh\ncase "$*" in *ls-files*|*status*) echo $$ >> '${pids}'; sleep 20;; esac\nexec '${Bun.which('git')}' "$@"\n`,
  )
  await chmod(path.join(shim, 'git'), 0o755)
})

afterEach(async () => {
  const left = await readFile(pids, 'utf8').catch(() => '')
  for (const pid of left.split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {
      // already gone
    }
  }
  await rm(root, { recursive: true, force: true })
  await rm(tmp, { recursive: true, force: true })
})

for (const signal of ['SIGINT', 'SIGKILL'] as const) {
  it(`a run stopped by ${signal} while git lists leaves no vx-git-* behind`, async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, BIN, 'run', 'build', '--all'],
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        PATH: `${shim}${path.delimiter}${process.env['PATH'] ?? ''}`,
        TMPDIR: tmp,
        NO_COLOR: '1',
        CI: '',
      },
    })
    const deadline = Date.now() + 15_000
    while ((await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('git never listed')
      await Bun.sleep(20)
    }
    proc.kill(signal)
    await proc.exited
    expect((await readdir(tmp)).filter((n) => n.startsWith('vx-git-'))).toEqual([])
  }, 30_000)
}
