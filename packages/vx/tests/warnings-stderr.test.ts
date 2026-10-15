// A run's warnings (`[vx] app#build: cache.outputs matched no files …`)
// printed on stdout between the task rows, so `vx run build > log.txt`
// carried them into the log and a terminal-less reader of stdout got
// them as rows (DX bug hunt, 2026-10-15). They go to stderr; the rows
// and the footer stay on stdout.

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

it(
  'a run’s warnings go to stderr, its rows and footer to stdout',
  async () => {
    const fixture = await makeWorkspace('vx-warn-stderr-')
    try {
      await addProject(fixture.root, 'app', {
        config: `export default { tasks: {
          build: {
            exec: { command: 'true' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
          },
        } }`,
        files: { 'src/a.ts': 'x' },
      })
      const out = pipe()
      const err = pipe()
      await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: defaultLogger({ enabled: false }, { mode: 'broad' }, out, { err }),
      })
      expect(err.text()).toContain('app#build: cache.outputs matched no files')
      expect(out.text()).not.toContain('matched no files')
      expect(out.text()).toMatch(/app#build/)
      expect(out.text()).toContain('─ vx ')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
