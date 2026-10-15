// One blank line between blocks (org/devex/log-design.md): a failure's
// frame ends with its own blank line, and the footer opened with another,
// so a red run printed two above `─ vx`.

import { rm } from 'node:fs/promises'
import { expect, it } from 'bun:test'
import { defaultLogger } from '../src/report/logger.js'
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
    expect(out).toMatch(/└─ app#lint ── \([^)]+\) failed \(exit 1\)\n\n─ vx /)
  },
  TIMEOUT,
)

it(
  'CONTROL: a green run’s last row and the footer are one blank line apart',
  async () => {
    const out = await runs('true')
    expect(out).toMatch(/no-cache app#\w+\n\n─ vx /)
  },
  TIMEOUT,
)
