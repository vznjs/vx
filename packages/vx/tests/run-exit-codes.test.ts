// `vx run`'s answers that a sweep of `cli/run.ts` (E-13, never swept
// before) found unheld: an anchored spec with no project, and a picker
// interrupted at its prompt. The parser itself held every mutant; these
// are the paths around it.

import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { run as cli } from './helpers/cli.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

let root = ''

beforeAll(async () => {
  root = realpathSync(await makeWorkspace({ prefix: 'vx-run-exit-' }))
  await addProject(root, 'app', {
    config: `export default { tasks: {
      build: { exec: { command: 'true' } },
    } }\n`,
  })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('vx run', () => {
  it('refuses an anchored spec with no project or no task, by name', async () => {
    const refused = []
    for (const spec of ['#build', 'app#', '#']) {
      refused.push(await resolveRunOptions(parseRunArgs([spec]), root, [spec]))
    }
    expect(refused).toEqual([
      {
        error: `missing project name before '#' in "#build" (vx run build --all runs it in every project)`,
      },
      { error: `missing task name after '#' in "app#" (vx show app lists the tasks)` },
      // Both halves empty: the task is what is missing, not an empty name to run.
      { error: `missing task name after '#' in "#" (vx show lists the tasks)` },
    ])
  })

  it('refuses an empty or blank task name in its own words, run and watch alike', async () => {
    // It reached the orchestrator, which answered in the embedder API's
    // words ("RunOptions.tasks names no task").
    const refused = []
    for (const verb of ['run', 'watch'] as const) {
      for (const tasks of [[''], [' '], ['build', '']]) {
        refused.push(await resolveRunOptions(parseRunArgs(['--all', ...tasks]), root, tasks, verb))
      }
    }
    const empty = (t: string) => ({
      error: `empty task name ${JSON.stringify(t)} (vx show lists the tasks)`,
    })
    expect(refused).toEqual([empty(''), empty(' '), empty(''), empty(''), empty(' '), empty('')])
  })

  it('refuses a padded task name, by name', async () => {
    // `vx run 'build ' --all` said "no projects declare task(s): build",
    // its space invisible. No config can declare it (taskNameProblem).
    const refused = []
    for (const spec of ['build ', 'app# build']) {
      refused.push(await resolveRunOptions(parseRunArgs(['--all', spec]), root, [spec]))
    }
    expect(refused).toEqual([
      { error: `task name "build " has surrounding whitespace (vx show lists the tasks)` },
      { error: `task name " build" has surrounding whitespace (vx show lists the tasks)` },
    ])
  })

  it('Ctrl-C at the picker exits 130, as an interrupted run does', async () => {
    // The picker runs only on a terminal: stdin, stdout and stderr (the
    // menu's stream) are TTY streams here, and Ctrl-C reaches readline raw
    // (E-6 pinned pickTask's answer; this pins the verb's exit for it).
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const stdout = Object.assign(new PassThrough(), { isTTY: true })
    const stderr = Object.assign(new PassThrough(), { isTTY: true })
    stdout.on('data', () => undefined)
    stderr.on('data', () => undefined)
    const inDesc = Object.getOwnPropertyDescriptor(process, 'stdin')!
    const outDesc = Object.getOwnPropertyDescriptor(process, 'stdout')!
    const errDesc = Object.getOwnPropertyDescriptor(process, 'stderr')!
    const prevCwd = process.cwd()
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true })
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true })
    process.chdir(root)
    try {
      const code = cli(['run'])
      await Bun.sleep(100)
      stdin.write('\x03')
      expect(await code).toBe(130)
    } finally {
      process.chdir(prevCwd)
      Object.defineProperty(process, 'stdin', inDesc)
      Object.defineProperty(process, 'stdout', outDesc)
      Object.defineProperty(process, 'stderr', errDesc)
    }
  })

  it('a JSON answer never opens the picker, even on a terminal', async () => {
    // An agent on a pty asked for JSON and waited at the menu.
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const stdout = Object.assign(new PassThrough(), { isTTY: true })
    const stderr = Object.assign(new PassThrough(), { isTTY: true })
    let out = ''
    stdout.on('data', (c: Buffer) => (out += c.toString()))
    stderr.on('data', () => undefined)
    const inDesc = Object.getOwnPropertyDescriptor(process, 'stdin')!
    const outDesc = Object.getOwnPropertyDescriptor(process, 'stdout')!
    const errDesc = Object.getOwnPropertyDescriptor(process, 'stderr')!
    const prevCwd = process.cwd()
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true })
    Object.defineProperty(process, 'stderr', { value: stderr, configurable: true })
    process.chdir(root)
    const codes: number[] = []
    const docs: unknown[] = []
    try {
      for (const flag of ['--format=json', '--dry=json']) {
        out = ''
        codes.push(await Promise.race([cli(['run', flag]), Bun.sleep(5_000).then(() => -1)]))
        docs.push((JSON.parse(out) as { error: { code: string } }).error.code)
      }
    } finally {
      stdin.end()
      process.chdir(prevCwd)
      Object.defineProperty(process, 'stdin', inDesc)
      Object.defineProperty(process, 'stdout', outDesc)
      Object.defineProperty(process, 'stderr', errDesc)
    }
    expect({ codes, docs }).toEqual({ codes: [1, 1], docs: ['VX_E_USAGE', 'VX_E_USAGE'] })
  })
})
