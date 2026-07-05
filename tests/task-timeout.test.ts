// Task timeout resolution — the per-task / env / workspace precedence.
// A task WITHOUT its own `exec.timeout` falls back, highest first:
//   RunOptions.timeout / `--timeout`  →  VX_TASK_TIMEOUT env  →  workspace
//   `timeout`. Per-task `exec.timeout` always wins. A timed-out task is
// killed (SIGTERM) and reported `failed` — never cached. The run-level
// defaults are threaded as options only, so they never touch a cache key.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run, optionsToRequest, requestToOptions } from '../src/orchestrator/index.js'
import { parseRunArgs } from '../src/cli/index.js'
import { loadWorkspaceConfig } from '../src/workspace/project-loader.js'

const TIMEOUT = 20_000

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-timeout-'))
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

async function setWorkspace(root: string, config: string): Promise<void> {
  await writeFile(path.join(root, 'vx.workspace.mjs'), config)
}

/** A task that sleeps well past any timeout under test, so a kill is the only
 *  way it can finish before the test's own budget. */
const SLEEPER = (name: string) =>
  `export default { tasks: { run: { exec: { command: 'sleep 30' } } } }\n// ${name}`

describe('task timeout — precedence', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
    delete process.env['VX_TASK_TIMEOUT']
  })
  afterEach(async () => {
    delete process.env['VX_TASK_TIMEOUT']
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'workspace `timeout` bounds a task with no exec.timeout',
    async () => {
      await addProject(fixture.root, 'a', SLEEPER('a'))
      await setWorkspace(fixture.root, 'export default { timeout: 250 }')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]!.status).toBe('failed')
      expect(fixture.err.join('')).toContain('timed out after 250ms')
    },
    TIMEOUT,
  )

  it(
    'VX_TASK_TIMEOUT env overrides a (longer) workspace default',
    async () => {
      await addProject(fixture.root, 'a', SLEEPER('a'))
      // Workspace alone would allow the sleep for 30s; the env's 250ms wins.
      await setWorkspace(fixture.root, 'export default { timeout: 30000 }')
      process.env['VX_TASK_TIMEOUT'] = '250'
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(fixture.err.join('')).toContain('timed out after 250ms')
    },
    TIMEOUT,
  )

  it(
    'RunOptions.timeout (`--timeout`) overrides the env default',
    async () => {
      await addProject(fixture.root, 'a', SLEEPER('a'))
      process.env['VX_TASK_TIMEOUT'] = '30000'
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        timeout: 250,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(fixture.err.join('')).toContain('timed out after 250ms')
    },
    TIMEOUT,
  )

  it(
    'per-task exec.timeout wins over both env and workspace',
    async () => {
      await addProject(
        fixture.root,
        'a',
        `export default { tasks: { run: { exec: { command: 'sleep 30', timeout: 250 } } } }`,
      )
      await setWorkspace(fixture.root, 'export default { timeout: 30000 }')
      process.env['VX_TASK_TIMEOUT'] = '30000'
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        timeout: 30000,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      // The per-task 250ms fired, not any of the 30s defaults.
      expect(fixture.err.join('')).toContain('timed out after 250ms')
    },
    TIMEOUT,
  )

  it(
    'per-task exec.timeout ALWAYS wins — a long per-task limit survives a short env',
    async () => {
      // Per-task 30s beats the env's 200ms; a 0.3s sleep completes normally.
      await addProject(
        fixture.root,
        'a',
        `export default { tasks: { run: { exec: { command: 'sleep 0.3', timeout: 30000 } } } }`,
      )
      process.env['VX_TASK_TIMEOUT'] = '200'
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'a malformed VX_TASK_TIMEOUT is ignored and falls through to workspace',
    async () => {
      await addProject(fixture.root, 'a', SLEEPER('a'))
      await setWorkspace(fixture.root, 'export default { timeout: 250 }')
      process.env['VX_TASK_TIMEOUT'] = 'not-a-number'
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      // The bad env was ignored; the workspace 250ms applied.
      expect(fixture.err.join('')).toContain('timed out after 250ms')
    },
    TIMEOUT,
  )

  it(
    'no timeout anywhere → a slow task is not killed',
    async () => {
      await addProject(
        fixture.root,
        'a',
        `export default { tasks: { run: { exec: { command: 'sleep 0.3' } } } }`,
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.status).toBe('success')
    },
    TIMEOUT,
  )
})

describe('task timeout — cache key stability', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
    delete process.env['VX_TASK_TIMEOUT']
  })
  afterEach(async () => {
    delete process.env['VX_TASK_TIMEOUT']
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a run-level --timeout run cache-hits a plain run (defaults never hashed)',
    async () => {
      await addProject(
        fixture.root,
        'a',
        `export default {
          tasks: {
            run: {
              exec: { command: 'echo done' },
              cache: { inputs: { files: ['package.json'] }, outputs: { files: [] } },
            },
          },
        }`,
      )
      const plain = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(plain.outcomes[0]!.status).toBe('success')
      const withTimeout = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        timeout: 5000,
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      // The default is threaded as an option, never folded into the key.
      expect(withTimeout.outcomes[0]!.status).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('task timeout — --timeout parsing', () => {
  it('accepts --timeout <ms> and --timeout=<ms>', () => {
    expect(parseRunArgs(['--timeout', '500']).timeout).toBe(500)
    expect(parseRunArgs(['--timeout=750']).timeout).toBe(750)
  })
  it('rejects non-positive / non-integer values', () => {
    expect(parseRunArgs(['--timeout', 'abc']).error).toContain('--timeout')
    expect(parseRunArgs(['--timeout', '0']).error).toContain('--timeout')
    expect(parseRunArgs(['--timeout', '-5']).error).toContain('--timeout')
    expect(parseRunArgs(['--timeout']).error).toContain('requires a value')
  })
  it('defaults to undefined when absent', () => {
    expect(parseRunArgs(['build']).timeout).toBeUndefined()
  })
})

describe('task timeout — wire round-trip', () => {
  it('threads RunOptions.timeout through the request mappers', () => {
    const req = optionsToRequest({ cwd: '/x', tasks: ['run'], timeout: 1234 })
    expect(req.timeout).toBe(1234)
    expect(requestToOptions(req).timeout).toBe(1234)
  })
  it('omits timeout when unset', () => {
    const req = optionsToRequest({ cwd: '/x', tasks: ['run'] })
    expect(req.timeout).toBeUndefined()
    expect(requestToOptions(req).timeout).toBeUndefined()
  })
})

describe('workspace timeout — loader validation', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-timeout-ws-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('accepts a positive-integer timeout', async () => {
    await setWorkspace(root, 'export default { timeout: 5000 }')
    const cfg = await loadWorkspaceConfig(root)
    expect(cfg?.timeout).toBe(5000)
  })
  it('rejects a non-positive / non-integer timeout', async () => {
    await setWorkspace(root, 'export default { timeout: 0 }')
    await expect(loadWorkspaceConfig(root)).rejects.toThrow('timeout')
    await setWorkspace(root, 'export default { timeout: 1.5 }')
    await expect(loadWorkspaceConfig(root)).rejects.toThrow('timeout')
    await setWorkspace(root, 'export default { timeout: "nope" }')
    await expect(loadWorkspaceConfig(root)).rejects.toThrow('timeout')
  })
})
