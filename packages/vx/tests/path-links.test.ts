// A failed task's paths become terminal links to the file under the
// task's project (`orchestrator/path-links.ts`), only in a terminal known
// to open them (`terminalLinks`).

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { formatTaskBlock } from '../src/orchestrator/framed-output.js'
import { fileMemo, linkPaths } from '../src/orchestrator/path-links.js'
import { terminalLinks } from '../src/orchestrator/terminal-signals.js'

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-links-')))
const dir = path.join(root, 'pkg')
mkdirSync(path.join(dir, 'src'), { recursive: true })
writeFileSync(path.join(dir, 'src', 'a.ts'), '')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const link = (abs: string, text: string) =>
  `\x1b]8;;file://${encodeURI(abs)}\x1b\\${text}\x1b]8;;\x1b\\`
const a = path.join(dir, 'src', 'a.ts')

describe('linkPaths', () => {
  it('links a path that names a file under the project, with its position', () => {
    const at = (t: string) => linkPaths(t, dir, fileMemo())
    expect(at('src/a.ts:12:5 - error')).toBe(`${link(a, 'src/a.ts:12:5')} - error`)
    expect(at('src/a.ts(12,5): error')).toBe(`${link(a, 'src/a.ts(12,5)')}: error`)
    expect(at('at ./src/a.ts:3')).toBe(`at ${link(a, './src/a.ts:3')}`)
    expect(at(`${a}:1`)).toBe(link(a, `${a}:1`))
  })

  it('leaves what is no file of the project as written', () => {
    const at = (t: string) => linkPaths(t, dir, fileMemo())
    for (const t of [
      'src/missing.ts:1',
      'https://x.dev/src/a.ts',
      'node@1.2.3',
      'pkg/src/a.ts',
      '\x1b]8;;file:///x\x1b\\src/a.ts\x1b]8;;\x1b\\',
    ])
      expect(at(t)).toBe(t)
  })

  it('encodes the target, never the text', () => {
    const spaced = path.join(root, 'my pkg')
    mkdirSync(spaced)
    writeFileSync(path.join(spaced, 'a.ts'), '')
    expect(linkPaths('a.ts:2', spaced, fileMemo())).toBe(
      `\x1b]8;;file://${root}/my%20pkg/a.ts\x1b\\a.ts:2\x1b]8;;\x1b\\`,
    )
  })

  it('asks the file system once per path', () => {
    let asked = 0
    const memo = fileMemo()
    const counted = (abs: string) => (asked++, memo(abs))
    expect(counted(a) && counted(a)).toBe(true)
    linkPaths('src/a.ts src/a.ts', dir, memo)
    expect(asked).toBe(2)
  })
})

describe('formatTaskBlock links only a failed task, only when asked', () => {
  const node = {
    id: 'pkg#build',
    projectName: 'pkg',
    taskName: 'build',
    projectDir: dir,
    config: { exec: { command: 'tsc' } },
  } as unknown as TaskNode
  const outcome = (status: TaskOutcome['status']): TaskOutcome =>
    ({ node, status, exitCode: status === 'failed' ? 1 : 0, durationMs: 0 }) as TaskOutcome
  const body = { output: [{ text: 'src/a.ts:1:1 error\n', err: false }] }
  const render = (status: TaskOutcome['status'], links: boolean) =>
    formatTaskBlock(node, outcome(status), body, { enabled: false }, false, [], links)

  it('a failed task in a linking terminal', () => {
    expect(render('failed', true)).toContain(`\n${link(a, 'src/a.ts:1:1')} error\n`)
  })

  it('controls: a success, and a terminal that does not link', () => {
    expect(render('success', true)).toContain('\nsrc/a.ts:1:1 error\n')
    expect(render('failed', false)).toContain('\nsrc/a.ts:1:1 error\n')
    expect(render('success', true)).not.toContain('\x1b]8;')
    expect(render('failed', false)).not.toContain('\x1b]8;')
  })
})

describe('terminalLinks', () => {
  it('names the terminals that open OSC 8', () => {
    for (const env of [
      { TERM_PROGRAM: 'ghostty' },
      { TERM_PROGRAM: 'WezTerm' },
      { TERM_PROGRAM: 'vscode' },
      { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.1.0' },
      { WT_SESSION: 'x' },
      { KITTY_WINDOW_ID: '1' },
      { KONSOLE_VERSION: '230800' },
      { VTE_VERSION: '7600' },
    ])
      expect([env, terminalLinks(env)]).toEqual([env, true])
  })

  it('and no other', () => {
    for (const env of [
      {},
      { TERM_PROGRAM: 'Apple_Terminal' },
      { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.0.15' },
      { VTE_VERSION: '4803' },
      { TERM_PROGRAM: 'tmux', KITTY_WINDOW_ID: '1' },
      { TMUX: '/tmp/t', TERM_PROGRAM: 'ghostty' },
      { STY: '1.s', WT_SESSION: 'x' },
    ])
      expect([env, terminalLinks(env)]).toEqual([env, false])
  })
})
