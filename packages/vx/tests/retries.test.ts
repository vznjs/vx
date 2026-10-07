// Task-level retries — `exec.retries` + the `--retry <n>` run-level
// default. A failed attempt re-executes up to `retries` more times; the
// final outcome (and the cached artifact) is the last attempt's. The
// CLI default never touches cache keys.

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import type { Logger, RunSummaryRecord, TelemetrySink } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { parseRunArgs } from '../src/cli/run.js'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

const TIMEOUT = 20_000
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

interface Fixture {
  root: string
  out: string[]
  err: string[]
}

let fixture: Fixture

const capturingLogger = (f: Fixture): Logger => ({
  status() {},
  taskStdout(_node, chunk) {
    f.out.push(chunk)
  },
  taskStderr(_node, chunk) {
    f.err.push(chunk)
  },
  taskComplete() {},
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-retries-' })
  return { root, out: [], err: [] }
}

async function vx(root: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

function lineCount(file: string): number {
  return readFileSync(file, 'utf8').trim().split('\n').length
}

describe('exec.retries — e2e', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  // Item 1101: the outcome carried the last attempt's duration alone, so a
  // retried task read shorter than the run spent on it.
  it(
    "a retried task's duration is every attempt's, not the last one's",
    async () => {
      await addProject(
        fixture.root,
        'slowflaky',
        `export default {
          tasks: {
            build: {
              exec: {
                command: 'sleep 0.3; if test -f flag.txt; then exit 0; else touch flag.txt; exit 1; fi',
                retries: 1,
              },
            },
          },
        }
        `,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['slowflaky'],
        log: capturingLogger(fixture),
      })
      expect(r.outcomes[0]!.attempts).toBe(2)
      // Two attempts of 300 ms each; the last alone is ~300.
      expect(r.outcomes[0]!.durationMs).toBeGreaterThanOrEqual(580)
    },
    TIMEOUT,
  )

  it(
    'fails once, succeeds on the retry; the winning attempt is cached',
    async () => {
      await addProject(
        fixture.root,
        'flaky',
        `export default {
          tasks: {
            build: {
              exec: {
                command: 'if test -f flag.txt; then echo winning-run; else touch flag.txt; echo losing-run; exit 1; fi',
                retries: 1,
              },
              cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
            },
          },
        }
        `,
      )
      const r1 = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['flaky'],
        log: capturingLogger(fixture),
      })
      expect(r1.ok).toBe(true)
      expect(r1.outcomes[0]!.status).toBe('success')
      expect(r1.outcomes[0]!.attempts).toBe(2)
      expect(fixture.err.join('')).toContain('vx: retrying flaky#build (attempt 2/2) after exit 1')

      // Second run is a cache hit; the replayed stdout carries ONLY the
      // winning attempt's output, never the failed attempt's.
      const f2: Fixture = { root: fixture.root, out: [], err: [] }
      const r2 = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['flaky'],
        log: capturingLogger(f2),
      })
      expect(r2.ok).toBe(true)
      expect(r2.outcomes[0]!.status).toBe('cache-hit')
      const replayed = f2.out.join('')
      expect(replayed).toContain('winning-run')
      expect(replayed).not.toContain('losing-run')
    },
    TIMEOUT,
  )

  it(
    'all attempts fail: last exit code surfaces, command ran exactly 1 + retries times',
    async () => {
      const dir = await addProject(
        fixture.root,
        'stubborn',
        `export default {
          tasks: {
            build: {
              exec: { command: 'echo x >> attempts.txt; exit 3', retries: 2 },
            },
          },
        }
        `,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['stubborn'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]!.status).toBe('failed')
      expect(r.outcomes[0]!.exitCode).toBe(3)
      expect(r.outcomes[0]!.attempts).toBe(3)
      expect(lineCount(path.join(dir, 'attempts.txt'))).toBe(3)
    },
    TIMEOUT,
  )

  it(
    'single successful attempt carries no `attempts` field',
    async () => {
      await addProject(
        fixture.root,
        'plain',
        `export default {
          tasks: {
            build: { exec: { command: 'echo ok', retries: 3 } },
          },
        }
        `,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['plain'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.attempts).toBeUndefined()
    },
    TIMEOUT,
  )

  // A retry's clean removed the failed attempt's `out/a.txt` and pruned the
  // emptied `out/`, which a sibling running beside it had just made and
  // was about to write into: the sibling failed "Directory nonexistent".
  // The same held for a workspace output.
  for (const [where, dir, outputs] of [
    ['project', 'out', (f: string) => `{ files: ['out/${f}'] }`],
    ['workspace', '../../out', (f: string) => `{ files: [], workspaceFiles: ['out/${f}'] }`],
  ] as const) {
    it(
      `a retry's clean leaves a sibling's ${where} output directory standing`,
      async () => {
        await addProject(
          fixture.root,
          'p',
          `export default {
            tasks: {
              flaky: {
                exec: {
                  command: 'while [ ! -e ready ]; do sleep 0.01; done; if [ -e tried ]; then touch go; exit 1; fi; touch tried; echo a > ${dir}/a.txt; exit 1',
                  retries: 1,
                },
                cache: { inputs: { files: ['package.json'] }, outputs: ${outputs('a.txt')} },
              },
              other: {
                exec: { command: 'mkdir -p ${dir} && touch ready && while [ ! -e go ]; do sleep 0.01; done; echo b > ${dir}/b.txt' },
                cache: { inputs: { files: ['package.json'] }, outputs: ${outputs('b.txt')} },
              },
            },
          }
          `,
        )
        const r = await run({
          cwd: fixture.root,
          tasks: ['flaky', 'other'],
          projects: ['p'],
          log: capturingLogger(fixture),
        })
        const status = Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))
        expect(status).toEqual({ 'p#flaky': 'failed', 'p#other': 'success' })
        const b = path.join(fixture.root, 'packages/p', dir, 'b.txt')
        expect(readFileSync(b, 'utf8')).toBe('b\n')
      },
      TIMEOUT,
    )
  }

  it(
    'the retried attempt count reaches the telemetry summary (flaky signal)',
    async () => {
      await addProject(
        fixture.root,
        'flaky',
        `export default {
          tasks: {
            build: {
              exec: {
                command: 'if test -f flag.txt; then echo win; else touch flag.txt; exit 1; fi',
                retries: 1,
              },
              cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
            },
          },
        }
        `,
      )
      let captured: RunSummaryRecord | undefined
      const sink: TelemetrySink = {
        onRunSummary(summary) {
          captured = summary
        },
      }
      const r = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['flaky'],
        log: capturingLogger(fixture),
        telemetrySinks: [sink],
      })
      expect(r.ok).toBe(true)
      const task = captured?.tasks.find((t) => t.taskId === 'flaky#build')
      expect(task?.status).toBe('success')
      expect(task?.attempts).toBe(2)
      // The attempt that failed, when it ended: inside the run, before its end.
      const [first] = task?.failedAttempts ?? []
      expect(task?.failedAttempts?.length).toBe(1)
      expect(first!.exitCode).toBe(1)
      expect(first!.endedAt).toBeGreaterThanOrEqual(captured!.startedAt)
      expect(first!.endedAt).toBeLessThanOrEqual(captured!.endedAt)
    },
    TIMEOUT,
  )
})

describe('--retry — run-level default (real CLI)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'applies to a task without config retries',
    async () => {
      const dir = await addProject(
        fixture.root,
        'flaky',
        `export default {
          tasks: {
            build: {
              exec: {
                command: 'echo x >> count.txt; if test -f flag.txt; then echo ok; else touch flag.txt; exit 1; fi',
              },
            },
          },
        }
        `,
      )
      const r = await vx(fixture.root, ['run', 'flaky#build', '--retry', '1'])
      expect(r.code).toBe(0)
      expect(lineCount(path.join(dir, 'count.txt'))).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'explicit `retries: 0` in config wins over --retry 5 (fails immediately)',
    async () => {
      const dir = await addProject(
        fixture.root,
        'pinned',
        `export default {
          tasks: {
            build: {
              exec: { command: 'echo x >> count.txt; exit 7', retries: 0 },
            },
          },
        }
        `,
      )
      const r = await vx(fixture.root, ['run', 'pinned#build', '--retry', '5'])
      expect(r.code).toBe(1)
      expect(lineCount(path.join(dir, 'count.txt'))).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'never affects cache keys: a --retry run hits the entry a plain run saved',
    async () => {
      const dir = await addProject(
        fixture.root,
        'stable',
        `export default {
          tasks: {
            build: {
              exec: { command: 'echo x >> count.txt && echo built' },
              cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
            },
          },
        }
        `,
      )
      const r1 = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['stable'],
        log: capturingLogger(fixture),
      })
      expect(r1.ok).toBe(true)
      expect(r1.outcomes[0]!.status).toBe('success')

      const r2 = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['stable'],
        retries: 3,
        log: capturingLogger(fixture),
      })
      expect(r2.ok).toBe(true)
      expect(r2.outcomes[0]!.status).toBe('cache-hit')
      expect(lineCount(path.join(dir, 'count.txt'))).toBe(1)
    },
    TIMEOUT,
  )
})

describe('exec.retries — loader validation', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-retries-loader-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const load = async (exec: string) => {
    const file = path.join(dir, 'vx.config.mjs')
    await writeFile(file, `export default { tasks: { t: { exec: ${exec} } } }`)
    return loadProjectConfig(file)
  }

  it('rejects negative / non-integer / non-number retries', async () => {
    await expect(load(`{ command: 'x', retries: -1 }`)).rejects.toThrow(/non-negative integer/)
    await expect(load(`{ command: 'x', retries: 1.5 }`)).rejects.toThrow(/non-negative integer/)
    await expect(load(`{ command: 'x', retries: '2' }`)).rejects.toThrow(/non-negative integer/)
  })

  it('accepts 0 and positive integers', async () => {
    expect((await load(`{ command: 'x', retries: 0 }`)).tasks?.t?.exec?.retries).toBe(0)
    expect((await load(`{ command: 'x', retries: 2 }`)).tasks?.t?.exec?.retries).toBe(2)
  })

  it('rejects retries on a persistent task', async () => {
    await expect(load(`{ command: 'x', retries: 1, persistent: {} }`)).rejects.toThrow(
      /not allowed on a persistent task/,
    )
  })
})

describe('--retry — CLI parser', () => {
  it('parses --retry <n> and --retry=<n>', () => {
    expect(parseRunArgs(['build', '--retry', '2']).retries).toBe(2)
    expect(parseRunArgs(['build', '--retry=2']).retries).toBe(2)
    expect(parseRunArgs(['build', '--retry', '0']).retries).toBe(0)
    expect(parseRunArgs(['build']).retries).toBeUndefined()
  })

  it('rejects garbage values', () => {
    expect(parseRunArgs(['build', '--retry', '-1']).error).toMatch(/--retry/)
    expect(parseRunArgs(['build', '--retry', 'abc']).error).toMatch(/--retry/)
    expect(parseRunArgs(['build', '--retry', '1.5']).error).toMatch(/--retry/)
    expect(parseRunArgs(['build', '--retry=']).error).toMatch(/--retry/)
    expect(parseRunArgs(['build', '--retry']).error).toMatch(/--retry requires a value/)
  })
})

describe('retries — wire mapping', () => {})
