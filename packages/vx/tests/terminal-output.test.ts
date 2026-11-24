// Where vx's own output is coloured (a terminal, CI, FORCE_COLOR), a task's
// colours and links reach it, but no other escape: a task's cursor-up and
// line erase rewrote vx's frame above its output, its alternate screen and
// hidden cursor outlived the run, and its OSC title (or clipboard write)
// reached the terminal as vx's (hardening, 2026-11-24).

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import type { Logger } from '../src/report/logger.js'
import { terminalOutput } from '../src/report/plain-output.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const A = { id: 'a#build' } as TaskNode

const HOSTILE =
  'a\x1b[2A\x1b[2Kup\x1b]0;TITLE\x07\x1b]52;c;cHduZWQ=\x07\x1b[?1049h\x1b[?25l\x1bc\x1b7' +
  '\x1b[1;31mred\x1b[0m \x1b]8;;https://x.example\x07link\x1b]8;;\x07 done\n'
const KEPT = 'a\x1b[2Kup\x1b[1;31mred\x1b[0m \x1b]8;;https://x.example\x07link\x1b]8;;\x07 done\n'

describe('terminalOutput', () => {
  it('keeps colours and links, drops every other escape', () => {
    const said: string[] = []
    const sink: Logger = {
      status: () => {},
      taskStdout: (_n, c) => said.push(c),
      taskStderr: (_n, c) => said.push(c),
      taskComplete: () => {},
    }
    const log = terminalOutput(sink)
    log.taskStdout(A, HOSTILE)
    log.taskStderr(A, 'x\x1b[3')
    log.taskStderr(A, '1my\x1b[0m\x1b[5')
    log.taskStderr(A, 'Bz\n')
    log.taskStdout(A, '10%\x1b[2K\x1b[1G100%\n')
    // A spinner's `\r` then erase to the line's end: dropped, a shorter
    // frame left the longer one's tail on screen (`oknking a long name`).
    log.taskStdout(A, '\rlinking a long name\x1b[K\rok\x1b[0K\n')
    expect(said).toEqual([
      KEPT,
      'x',
      '\x1b[31my\x1b[0m',
      'z\n',
      '10%\x1b[2K\x1b[1G100%\n',
      '\rlinking a long name\x1b[K\rok\x1b[0K\n',
    ])
  })
})

describe('a coloured run', () => {
  let root = ''
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-terminal-output-' })
    await addProject(
      root,
      'a',
      `export default { tasks: { build: { exec: { command: ${JSON.stringify(`printf '${HOSTILE.replaceAll('\x1b', '\\033').replaceAll('\x07', '\\007').replaceAll('\n', '\\n')}'`)} } } } }\n`,
    )
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("prints the task's colours and links, and none of its other escapes", () => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'a#build', '--output-logs', 'full'],
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' },
    })
    const out = p.stdout.toString()
    expect(p.exitCode).toBe(0)
    expect({
      colour: out.includes('\x1b[1;31mred'),
      link: out.includes('\x1b]8;;https://x.example\x07link'),
      injected: [
        '\x1b[2A',
        '\x1b]0;',
        '\x1b]52;',
        '\x1b[?1049h',
        '\x1b[?25l',
        '\x1bc',
        '\x1b7',
      ].filter((e) => out.includes(e)),
    }).toEqual({ colour: true, link: true, injected: [] })
  })
})
