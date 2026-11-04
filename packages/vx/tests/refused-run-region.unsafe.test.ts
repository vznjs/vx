// A run refused or thrown before its tasks never reached the end that
// takes the live region down. On a terminal, a load slow enough to show its
// step (150 ms) left `vx:load running` drawn, and the refusal was written
// onto the region's last line: `vx:load✗ vx run  no projects declare…`.
// Every way out of run() now takes the region down. Unsafe: a pty, which
// macOS's sandbox refuses (terminal.unsafe.test.ts).
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-refused-region-' })
  await addProject(root, 'p', {
    config: `export default { tasks: { b: { exec: { command: 'true' } } } }`,
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A workspace whose `discover` stage takes 600 ms, then does `then` (not while locking). */
async function slowLoad(then: string): Promise<void> {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
      'slow-load',
      `{ async discover() { if (process.argv.includes('lock')) return []; await new Promise((r) => setTimeout(r, 600)); ${then} } }`,
    )}] }\n`,
  )
}

/** What a run on a terminal writes, as the terminal receives it. */
async function onTerminal(args: string[]): Promise<{ code: number; screen: string }> {
  let screen = ''
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    terminal: {
      cols: 100,
      rows: 40,
      data: (_term, data) => {
        screen += new TextDecoder().decode(data)
      },
    },
  })
  const code = await proc.exited
  proc.terminal?.close()
  return { code, screen }
}

const ERASE = '\x1b[J'

/**
 * Whether `line` starts at the left edge on a clean line: after a line end,
 * a carriage return (a cleared line is `ESC[2K` then `\r`) or an erase,
 * never at the end of a drawn row.
 */
function startsClean(screen: string, line: string): boolean {
  const at = screen.indexOf(line)
  expect(at).toBeGreaterThan(0)
  const prior = screen.slice(0, at)
  return prior.endsWith('\n') || prior.endsWith('\r') || prior.endsWith(ERASE)
}

it('a refused run takes the region down before the refusal', async () => {
  await slowLoad('return []')
  const { code, screen } = await onTerminal(['run', 'nosuch', '--all'])
  expect(code).toBe(1)
  expect(screen).toContain('vx:load')
  expect(startsClean(screen, '✗ vx run')).toBe(true)
}, 20_000)

it('a run whose load throws takes the region down before the error', async () => {
  await slowLoad(`throw new Error('discover broke')`)
  const { code, screen } = await onTerminal(['run', 'b', '--all'])
  expect(code).toBe(1)
  expect(screen).toContain('discover broke')
  expect(startsClean(screen, '✗ vx run')).toBe(true)
}, 20_000)
