// The git a cold run spawns, as an exact list. The input enumeration asked
// `rev-parse --show-prefix --git-common-dir` and the file hasher asked
// `rev-parse --show-object-format` in a spawn of its own; one `rev-parse`
// answers all three (`repoFacts` in cache/git-inputs.ts), whichever reader
// asks first — the enumeration on an unscoped run, the config load's
// `hashBytes` on a scoped one.
//
// A shim first on the child's PATH logs every git call: the real CLI in a
// subprocess, because which git runs is decided by the PATH vx resolves on.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

const ENUMERATION = [
  'config --get-regexp ^core\\.(autocrlf|eol|attributesfile)$',
  'rev-parse --show-prefix --git-common-dir --show-object-format',
]

describe('git spawns on a cold run', () => {
  let root: string
  let shim: string
  let log: string

  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-git-once-' })
    for (const name of ['a', 'b']) {
      await addProject(root, name, { config: CONFIG, files: { 'src/a.txt': `${name}\n` } })
    }
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
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function coldRun(args: string[]): Promise<string[]> {
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${shim}${path.delimiter}${process.env['PATH'] ?? ''}`,
        NO_COLOR: '1',
        CI: '',
      },
    })
    expect(`${p.exitCode}\n${p.stderr.toString()}`).toStartWith('0\n')
    return (await readFile(log, 'utf8')).trim().split('\n').sort()
  }

  it(
    'unscoped: one rev-parse, asked by the enumeration, answers the hasher too',
    async () => {
      expect(await coldRun(['build', '--all'])).toEqual(
        [...ENUMERATION, 'ls-files -s -v -z -- .', 'status --porcelain -z -uall -- .'].sort(),
      )
    },
    TIMEOUT,
  )

  it(
    'scoped: one rev-parse, asked by the config load, answers the enumeration too',
    async () => {
      expect(await coldRun(['a#build'])).toEqual(
        [
          ...ENUMERATION,
          'ls-files -s -v -z -- packages/a',
          'status --porcelain -z -uall -- packages/a',
        ].sort(),
      )
    },
    TIMEOUT,
  )
})
