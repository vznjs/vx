// A run's warnings (`[vx] app#build: inputs matched no files …`)
// printed on stdout between the task rows, so `vx run build > log.txt`
// carried them into the log and a terminal-less reader of stdout got
// them as rows (DX bug hunt, 2026-10-15). They go to stderr; the rows
// and the footer stay on stdout.

import { rm } from 'node:fs/promises'
import { expect, it } from 'bun:test'
import { defaultLogger } from '../src/report/logger.js'
import type { StatusStream } from '../src/ui/live-region.js'
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
            inputs: { files: ['lib/**'] }, outputs: { files: [] }, cache: true,
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
      expect(err.text()).toContain('app#build: inputs matched no files')
      expect(out.text()).not.toContain('matched no files')
      expect(out.text()).toMatch(/app#build/)
      expect(out.text()).toContain('\n  Summary ')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)

it('a warning is painted by stderr’s own terminal, not stdout’s: `2> warn.log` gets no escapes', () => {
  const tty = { ...pipe(), isTTY: true, columns: 80 }
  const keys = ['CI', 'GITHUB_ACTIONS', 'FORCE_COLOR', 'NO_COLOR', 'TERM'] as const
  const saved = keys.map((k) => process.env[k])
  const wasTTY = process.stderr.isTTY
  const written: string[] = []
  const write = process.stderr.write
  for (const k of keys) delete process.env[k]
  process.stderr.write = ((c: string) => (written.push(String(c)), true)) as typeof write
  try {
    for (const isTTY of [false, true]) {
      Object.defineProperty(process.stderr, 'isTTY', { value: isTTY, configurable: true })
      written.length = 0
      defaultLogger({ enabled: true }, { mode: 'broad' }, tty).warn!('app#build: odd')
      expect(written.join('')).toContain('app#build: odd')
      expect(written.join('').includes('\x1b')).toBe(isTTY)
    }
  } finally {
    process.stderr.write = write
    Object.defineProperty(process.stderr, 'isTTY', { value: wasTTY, configurable: true })
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k]
      else process.env[k] = saved[i]
    })
  }
})
