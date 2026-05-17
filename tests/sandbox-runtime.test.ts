// Sandbox-runtime integration tests.
//
// The suite gates on SRT's runtime deps (bwrap on Linux, sandbox-exec
// on macOS). When they're absent, every test skips cleanly rather than
// failing — matches how the orchestrator itself behaves.
//
// Shape of each test: spin up a small workspace with a task that
// declares `sandbox: {...}`, run the orchestrator, assert on the
// outcome's exit code, cache status, and `sandboxViolations` count.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { probeSandbox } from '../src/exec/sandbox-runtime.js'
import { run, type Logger, type RunOptions } from '../src/orchestrator.js'

const TIMEOUT = 60_000

interface Fixture {
  root: string
  log: string[]
}

const collectingLogger = (fixture: Fixture): Logger => ({
  status(line) {
    fixture.log.push(line)
  },
  taskStdout() {},
  taskStderr(_node, chunk) {
    fixture.log.push(chunk.trimEnd())
  },
  taskComplete(node, outcome) {
    fixture.log.push(`task ${node.id} ${outcome.status}`)
  },
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-sandbox-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  return { root, log: [] }
}

async function addProject(
  root: string,
  name: string,
  args: { files?: Record<string, string>; config: string },
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

const availability = await probeSandbox()

describe.skipIf(!availability.available)(
  `sandbox-runtime (${availability.available ? 'ok' : availability.reason})`,
  () => {
    let fixture: Fixture

    beforeEach(async () => {
      fixture = await makeWorkspace()
    })

    afterEach(async () => {
      await rm(fixture.root, { recursive: true, force: true })
    })

    it(
      'caches a clean sandboxed task that stays inside declared inputs',
      async () => {
        // src/x.txt is in the declared inputs; cat reads it and writes
        // out.txt which is in the declared outputs. No undeclared reads
        // or writes → no violations → cache.save fires.
        await addProject(fixture.root, 'clean', {
          files: { 'src/x.txt': 'hello' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'cat src/x.txt > out.txt' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                  sandbox: {},
                },
              },
            }
          `,
        })
        const opts: RunOptions = {
          cwd: fixture.root,
          tasks: ['build'],
          log: collectingLogger(fixture),
        }
        const first = await run(opts)
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]?.status).toBe('success')
        expect(first.outcomes[0]?.sandboxViolations).toBeUndefined()

        const second = await run({ ...opts, log: collectingLogger(fixture) })
        expect(second.outcomes[0]?.status).toBe('cache-hit')
      },
      TIMEOUT,
    )

    it(
      'unsandboxed tasks (no sandbox: {}) run unchanged',
      async () => {
        await addProject(fixture.root, 'unsandboxed', {
          files: { 'src/x.txt': 'hello' },
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'cat src/x.txt > out.txt' },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        const r = await run({
          cwd: fixture.root,
          tasks: ['build'],
          log: collectingLogger(fixture),
        })
        expect(r.outcomes[0]?.status).toBe('success')
        expect(r.outcomes[0]?.sandboxViolations).toBeUndefined()
      },
      TIMEOUT,
    )

    it.skipIf(process.platform !== 'darwin')(
      'fails the task on sandbox violation (macOS)',
      async () => {
        // reader declares inputs from src/ only but reads a sibling
        // project's file. macOS's log monitor captures the violation;
        // the new policy fails the task even if the tool tolerated
        // the EPERM (here `|| true` keeps exit 0 at the shell level).
        await addProject(fixture.root, 'secret', {
          files: { 'token.txt': 'my-secret' },
          config: `export default { tasks: {} }`,
        })
        await addProject(fixture.root, 'reader', {
          files: { 'src/x.txt': 'hi' },
          config: `
            export default {
              tasks: {
                leak: {
                  exec: {
                    command: 'cat src/x.txt > out.txt; cat ../secret/token.txt 2>&1 || true',
                  },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                  sandbox: {},
                },
              },
            }
          `,
        })
        const r = await run({
          cwd: fixture.root,
          tasks: ['leak'],
          log: collectingLogger(fixture),
        })
        expect(r.ok).toBe(false)
        expect(r.outcomes[0]?.status).toBe('failed')
        expect(r.outcomes[0]?.sandboxViolations).toBeGreaterThan(0)
      },
      TIMEOUT,
    )
  },
)

describe('sandbox probe', () => {
  it('returns a stable shape', async () => {
    const a = await probeSandbox()
    expect(typeof a.available).toBe('boolean')
    expect(typeof a.reason).toBe('string')
    if (a.available) expect(a.reason).toBe('')
    else expect(a.reason.length).toBeGreaterThan(0)
  })
})

describe('sandbox config validation', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it('rejects sandbox: [] (must be an object)', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true' }, sandbox: [] } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('sandbox must be an object')
  })

  it('rejects unknown sandbox fields', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true' }, sandbox: { typo: true } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('sandbox.typo is not a known field')
  })

  it('rejects globs in allowRead', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { exec: { command: 'true' }, sandbox: { allowRead: ['**/*'] } } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('must be path prefixes')
  })

  it('rejects sandbox on group tasks (no exec)', async () => {
    await addProject(fixture.root, 'bad', {
      config: `export default { tasks: { x: { dependsOn: ['^build'], sandbox: {} } } }`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    }).catch((e: Error) => e)
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toContain('sandbox requires `exec`')
  })

  it('accepts the full SRT-mirroring shape', async () => {
    await addProject(fixture.root, 'full', {
      files: { 'src/x.txt': 'hi' },
      config: `
        export default {
          tasks: {
            x: {
              exec: { command: 'cat src/x.txt > out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              sandbox: {
                allowRead: ['/etc/hosts'],
                denyRead: [],
                allowWrite: [],
                denyWrite: [],
                allowGitConfig: false,
                network: { allowedDomains: ['*.example.com'], deniedDomains: [] },
                allowPty: false,
                enableWeakerNestedSandbox: false,
                enableWeakerNetworkIsolation: false,
                ignoreViolations: { 'cat ': ['/tmp/noisy'] },
              },
            },
          },
        }
      `,
    })
    // Only validates the config parses + runs through validation; the
    // actual exec is skipped when sandbox isn't available, but the
    // parse path is exercised either way.
    if (!availability.available) {
      const r = await run({
        cwd: fixture.root,
        tasks: ['x'],
        log: collectingLogger(fixture),
      }).catch((e: Error) => e)
      // Expect a "sandbox not available" UserError, not a config error.
      expect((r as Error).message).toContain('sandbox not available')
      return
    }
    const r = await run({
      cwd: fixture.root,
      tasks: ['x'],
      log: collectingLogger(fixture),
    })
    expect(r.ok).toBe(true)
  })
})
