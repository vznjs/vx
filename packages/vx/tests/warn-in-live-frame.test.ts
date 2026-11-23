// A warning a single task's run says while its live frame is open (outputs
// that matched nothing) opened a "Warnings" panel inside the frame, between
// the task's output and its closing line. Inside a frame it is a tagged line.

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
  "a single task's warning prints inside its frame as a line, not a Warnings panel",
  async () => {
    const fixture = await makeWorkspace('vx-warn-frame-')
    try {
      await addProject(fixture.root, 'app', {
        config: `export default { tasks: {
          build: { exec: { command: 'mkdir -p dist && echo built > dist/x && echo built' }, inputs: { files: ['package.json'] }, outputs: { files: ['build/**'] }, cache: true },
        } }`,
      })
      const out = pipe()
      await run({
        cwd: fixture.root,
        tasks: ['app#build'],
        log: defaultLogger({ enabled: true }, { mode: 'focused' }, out, { err: out, env: {} }),
        handleSignals: false,
      })
      const text = Bun.stripANSI(out.text())
      const open = text.indexOf('┌─ app#build')
      const close = text.indexOf('└─ app#build')
      expect([open >= 0, close > open]).toEqual([true, true])
      const inside = text.slice(open, close)
      expect(inside).toContain('outputs matched no files (build/**)')
      expect(inside).not.toContain('Warnings')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
