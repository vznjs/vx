// What a task's captured output keeps. The live stream is whole; the copy
// vx retains for the cache entry and its replay is the first and last
// CAPTURE_*_CHARS with the dropped middle named where it was. Unbounded,
// 200 MB of stdout was 620 MB of RSS on the miss and on every hit and a
// 193 MB row in cache.db (2026-09-16).

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  CAPTURE_HEAD_CHARS,
  CAPTURE_TAIL_CHARS,
  droppedOutputLine,
  runCommand,
} from '../src/exec/runner.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { gitIn, makeWorkspace, addProject } from './helpers/workspace.js'

const TIMEOUT = 60_000
/** `START`, then `n` x's, then `END` — the head and the tail are recognisable. */
const printer = (n: number): string =>
  `printf START; head -c ${n} /dev/zero | tr '\\0' x; printf END`

describe('a task’s retained output is bounded', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-capture-cap-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it(
    'keeps the head and the tail and names the dropped middle',
    async () => {
      const n = 40_000_000
      const r = await runCommand({ command: printer(n), cwd: dir, env: {} })
      expect(r.exitCode).toBe(0)
      const total = n + 'START'.length + 'END'.length
      const dropped = total - CAPTURE_HEAD_CHARS - CAPTURE_TAIL_CHARS
      const line = droppedOutputLine(dropped)
      expect(r.stdout.length).toBe(CAPTURE_HEAD_CHARS + CAPTURE_TAIL_CHARS + line.length)
      expect(r.stdout.startsWith('START')).toBe(true)
      expect(r.stdout.endsWith('END')).toBe(true)
      expect(r.stdout).toContain(line)
      expect(line).toContain('22.1 MiB of output not kept')
      // Live, every byte still streamed.
      let live = 0
      const again = await runCommand({
        command: printer(n),
        cwd: dir,
        env: {},
        onStdout: (c) => {
          live += c.length
        },
      })
      expect(again.exitCode).toBe(0)
      expect(live).toBe(total)
    },
    TIMEOUT,
  )

  it('control: output under the bound is kept whole, no line', async () => {
    const n = 1_000_000
    const r = await runCommand({ command: printer(n), cwd: dir, env: {} })
    expect(r.stdout.length).toBe(n + 8)
    expect(r.stdout).not.toContain('of output not kept')
  })
})

describe('the bound reaches the cache entry and its replay', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-capture-cap-e2e-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a hit replays the bounded text with the line, never the whole output',
    async () => {
      await addProject(root, 'chatty', {
        files: { 'src/x.txt': 'x' },
        config: `
          export default {
            tasks: {
              test: {
                exec: { command: ${JSON.stringify(printer(40_000_000))} },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      const quiet: Logger = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }
      const miss = await run({ cwd: root, tasks: ['test'], log: quiet })
      expect(miss.ok).toBe(true)
      let replayed = ''
      const collecting: Logger = {
        ...quiet,
        taskStdout(_node, chunk) {
          replayed += chunk
        },
      }
      const hit = await run({ cwd: root, tasks: ['test'], log: collecting })
      expect(hit.ok).toBe(true)
      expect(hit.outcomes[0]?.status).toBe('cache-hit')
      expect(replayed.length).toBeLessThan(CAPTURE_HEAD_CHARS + CAPTURE_TAIL_CHARS + 400)
      expect(replayed).toContain('of output not kept')
      expect(replayed.startsWith('START')).toBe(true)
      expect(replayed.endsWith('END')).toBe(true)
    },
    TIMEOUT,
  )
})
