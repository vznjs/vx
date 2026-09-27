// `vx run`'s answers that a sweep of `cli/run.ts` (E-13, never swept
// before) found unheld: an anchored spec with no project, and a picker
// interrupted at its prompt. The parser itself held every mutant; these
// are the paths around it.

import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { parseRunArgs, resolveRunOptions } from '../src/cli/run.js'
import { run as cli } from '../src/cli/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

let root = ''

beforeAll(async () => {
  root = realpathSync(await makeWorkspace({ prefix: 'vx-run-exit-' }))
  await addProject(root, 'app', {
    config: `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('vx run', () => {
  it('refuses an anchored spec with no project or no task, by name', async () => {
    const refused = []
    for (const spec of ['#build', 'app#']) {
      refused.push(await resolveRunOptions(parseRunArgs([spec]), root, [spec]))
    }
    expect(refused).toEqual([
      { error: 'invalid pkg#task: #build' },
      { error: 'invalid pkg#task: app#' },
    ])
  })

  it('Ctrl-C at the picker exits 130, as an interrupted run does', async () => {
    // The picker runs only on a terminal: stdin and stdout are TTY streams
    // here, and Ctrl-C reaches readline raw (E-6 pinned pickTask's answer;
    // this pins the verb's exit for it).
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const stdout = Object.assign(new PassThrough(), { isTTY: true })
    stdout.on('data', () => undefined)
    const inDesc = Object.getOwnPropertyDescriptor(process, 'stdin')!
    const outDesc = Object.getOwnPropertyDescriptor(process, 'stdout')!
    const prevCwd = process.cwd()
    const err = spyOn(process.stderr, 'write').mockImplementation((() => true) as never)
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true })
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true })
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
      err.mockRestore()
    }
  })
})
