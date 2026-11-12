// A module below the terminal says a notice as a fact (util/notice.ts) and
// `ui` draws it. One said before `ui` loads is held, never dropped.

import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = path.join(import.meta.dir, '..', 'src')

async function stderrOf(script: string): Promise<string> {
  const p = Bun.spawn([process.execPath, '-e', script], {
    cwd: SRC,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const err = await new Response(p.stderr).text()
  expect(await p.exited).toBe(0)
  return err
}

describe('notices', () => {
  it('one said before ui loads is drawn when it does', async () => {
    const err = await stderrOf(
      `import { notify } from './util/index.ts'\n` +
        `notify({ kind: 'line', tone: 'warn', text: '[vx] early: said first\\n' })\n` +
        `await import('./ui/index.ts')\n`,
    )
    expect(err).toBe('[vx] early: said first\n')
  })

  it('CONTROL: with no ui loaded, nothing is written', async () => {
    const err = await stderrOf(
      `import { notify } from './util/index.ts'\n` +
        `notify({ kind: 'line', tone: 'warn', text: '[vx] early: said first\\n' })\n`,
    )
    expect(err).toBe('')
  })

  it('a line is said as ui.say says it, a notice as ui.sayLine lays it out', async () => {
    const err = await stderrOf(
      `await import('./ui/index.ts')\n` +
        `const { notify } = await import('./util/index.ts')\n` +
        `notify({ kind: 'line', tone: 'error', text: '[vx] p#a: refused\\n' })\n` +
        `notify({ kind: 'notice', tone: 'warn', text: 'config a.ts still evaluating' })\n`,
    )
    expect(err).toBe('[vx] p#a: refused\n! vx  config a.ts still evaluating\n')
  })
})
