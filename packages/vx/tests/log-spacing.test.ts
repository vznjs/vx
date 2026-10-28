// One blank line between blocks (org/devex/log-design.md): a failure's
// frame ends with its own blank line, and the footer opened with another,
// so a red run printed two above `─ vx`.

import { rm } from 'node:fs/promises'
import { expect, it } from 'bun:test'
import { defaultLogger } from '../src/report/logger.js'
import type { TaskNode } from '../src/graph/index.js'
import type { StatusStream } from '../src/report/status-line.js'
import { addProject, makeWorkspace, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

function pipe(): StatusStream & { text(): string } {
  const chunks: string[] = []
  return {
    isTTY: false,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
    text: () => chunks.join(''),
  }
}

const runs = async (lint: string): Promise<string> => {
  const fixture = await makeWorkspace('vx-log-spacing-')
  try {
    await addProject(fixture.root, 'app', {
      config: `export default { tasks: {
        build: { exec: { command: 'true' } },
        lint: { exec: { command: ${JSON.stringify(lint)} } },
      } }`,
    })
    const out = pipe()
    await run({
      cwd: fixture.root,
      tasks: ['build', 'lint'],
      continueMode: 'always',
      log: defaultLogger({ enabled: false }, { mode: 'broad' }, out),
    })
    return out.text()
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
}

it(
  'a failure frame and the footer are one blank line apart',
  async () => {
    const out = await runs('echo broke >&2; exit 1')
    // A slow `vx:close` on a loaded box prints its row between them.
    expect(out).toMatch(
      /└─ app#lint ── \([^)]+\) failed \(exit 1\)\n\n(?: ⏺︎ +\S+ success internal vx:\w+\n\n)?─ vx /,
    )
  },
  TIMEOUT,
)

it(
  'CONTROL: a green run’s last row and the footer are one blank line apart',
  async () => {
    const out = await runs('true')
    // The last row may be an internal step the run waited on (`vx:close` on
    // a loaded box), not only a task.
    expect(out).toMatch(/success (?:no-cache app#\w+|internal vx:\w+)\n\n─ vx /)
  },
  TIMEOUT,
)

it('a row printed while a live task sits mid-line starts its own line', () => {
  const chunks: string[] = []
  const tty: StatusStream = {
    isTTY: true,
    columns: 200,
    rows: 50,
    write(c: string) {
      chunks.push(String(c))
      return true
    },
  }
  const log = defaultLogger({ enabled: false }, { mode: 'focused' }, tty, { env: {} })
  const node = {
    id: 'app#dev',
    projectName: 'app',
    taskName: 'dev',
    projectDir: '/x',
    requested: true,
    deps: [],
    config: { exec: { command: 'dev' } },
  } as unknown as TaskNode
  log.runStart?.({ total: 1, concurrency: 1, requestedCount: 1 })
  log.taskStart?.(node)
  log.taskStdout(node, 'building...')
  // A step the run did not wait on (`vx:prefetch`) ends while it streams.
  log.stepStart?.('vx:prefetch')
  log.stepEnd?.('vx:prefetch', { durationMs: 500, ok: true })
  log.runDone?.()
  const text = Bun.stripANSI(chunks.join(''))
  expect(text).toContain('building...\n')
})
