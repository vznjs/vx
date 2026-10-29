// The git a verb that never opens the shared store spawns: none. The store
// root (`~/.vx/<repo id>/cache`) is the repository's id, and a repository
// with no remote asks `git rev-list --max-parents=0 HEAD` for it; every
// verb that loaded the workspace asked, `vx --help` included, though only
// a verb that opens the store reads the answer.
//
// A shim first on the child's PATH logs every git call, as
// git-spawns-once.test.ts does.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { lock } from './helpers/orchestrator.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'true' },
        inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
      },
    },
  }
`

describe('reading verbs spawn no git', () => {
  let root: string
  let home: string
  let shim: string
  let log: string

  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-reading-git-' })
    home = path.join(root, '.home')
    await mkdir(home)
    await addProject(root, 'a', { config: CONFIG, files: { 'src/a.txt': 'a\n' } })
    await lock(root)
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    shim = path.join(root, '.shim')
    log = path.join(shim, 'calls.log')
    await mkdir(shim)
    await writeFile(
      path.join(shim, 'git'),
      `#!/bin/sh\necho "$@" >> '${log}'\nexec '${Bun.which('git')}' "$@"\n`,
    )
    await chmod(path.join(shim, 'git'), 0o755)
    // A run first, so `vx last` and `vx why` have one to read.
    await gitCalls(['run', 'build', '--all'])
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function gitCalls(args: string[]): Promise<string[]> {
    await rm(log, { force: true })
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${shim}${path.delimiter}${process.env['PATH'] ?? ''}`,
      HOME: home,
      NO_COLOR: '1',
      CI: '',
    }
    // The store root is asked only when the workspace names no cache dir.
    delete env['VX_CACHE_DIR']
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    })
    expect(`${p.exitCode}\n${p.stderr.toString()}`).toStartWith('0\n')
    return existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : []
  }

  it(
    'help, show, last, why and completions ask git nothing',
    async () => {
      for (const verb of [
        ['--help'],
        ['run', '--help'],
        ['show'],
        ['last'],
        ['why', 'a#build'],
        ['completions', 'bash'],
      ]) {
        expect({ verb, calls: await gitCalls(verb) }).toEqual({ verb, calls: [] })
      }
    },
    TIMEOUT,
  )

  it(
    'a verb that opens the store still finds it: `vx cache clean --dry` asks for the repo id',
    async () => {
      expect(await gitCalls(['cache', 'clean', '--dry'])).toEqual(['rev-list --max-parents=0 HEAD'])
    },
    TIMEOUT,
  )
})
