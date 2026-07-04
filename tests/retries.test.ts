// Task-level retries — `exec.retries` + the `--retry <n>` run-level
// default. A failed attempt re-executes up to `retries` more times; the
// final outcome (and the cached artifact) is the last attempt's. The
// CLI default never touches cache keys.

import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run, optionsToRequest, requestToOptions } from '../src/orchestrator/index.js'
import { parseRunArgs } from '../src/cli/index.js'
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-retries-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')
  return { root, out: [], err: [] }
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
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

describe('retries — wire mapping', () => {
  it('round-trips through RunRequest', () => {
    const req = optionsToRequest({ cwd: '/w', tasks: ['build'], retries: 2 })
    expect(req.retries).toBe(2)
    expect(requestToOptions(req).retries).toBe(2)
    expect(optionsToRequest({ cwd: '/w', tasks: ['build'] }).retries).toBeUndefined()
  })
})
