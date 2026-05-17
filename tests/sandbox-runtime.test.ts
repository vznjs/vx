// Sandbox-runtime integration tests.
//
// On the host running these tests we need SRT's runtime deps available
// (bwrap on Linux, sandbox-exec on macOS). The probe at the top of the
// file gates the suite — when deps are missing the tests skip cleanly
// rather than fail, matching how `--sandbox` itself behaves.
//
// The shape of each test is: spin up a small workspace, run the
// orchestrator with `sandbox: true`, assert on the outcomes (cache
// status, violation count). We don't poke SRT internals directly —
// the value is verifying the orchestrator-level contract.

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

// Resolved once at module load — keeps every test in this file from
// re-running the dep check. SRT itself memoizes after the first call
// but the cost is the same; doing it here makes the skip condition
// readable.
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
      'caches a clean task whose reads stay inside declared inputs',
      async () => {
        // Task reads only `src/x.txt` which is in its declared inputs.
        // No violations expected; cache.save should fire.
        await addProject(fixture.root, 'clean', {
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
        const opts: RunOptions = {
          cwd: fixture.root,
          tasks: ['build'],
          sandbox: true,
          log: collectingLogger(fixture),
        }
        const first = await run(opts)
        expect(first.ok).toBe(true)
        expect(first.outcomes[0]?.status).toBe('success')
        expect(first.outcomes[0]?.sandboxViolations).toBeUndefined()

        // Second run hits the cache — saving succeeded the first time.
        const second = await run({ ...opts, log: collectingLogger(fixture) })
        expect(second.outcomes[0]?.status).toBe('cache-hit')
      },
      TIMEOUT,
    )

    it.skipIf(process.platform !== 'darwin')(
      'skips cache.save when sandbox violations are detected (macOS)',
      async () => {
        // Two sibling projects. `reader` declares inputs from src/ only
        // but reads a file inside sibling project `secret`. The cross-
        // project read isn't covered by declared inputs, so the sandbox
        // log monitor records a violation. `|| true` keeps exit 0 so
        // we can isolate the cache-skip behavior from a normal failure.
        // macOS-only because Linux bwrap denies the read structurally
        // without populating SandboxViolationStore.
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
                    command: 'cat src/x.txt > out.txt; cat ../secret/token.txt >> out.txt || true',
                  },
                  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
                },
              },
            }
          `,
        })
        const opts: RunOptions = {
          cwd: fixture.root,
          tasks: ['leak'],
          sandbox: true,
          log: collectingLogger(fixture),
        }
        const first = await run(opts)
        expect(first.outcomes[0]?.status).toBe('success')
        expect(first.outcomes[0]?.sandboxViolations).toBeGreaterThan(0)

        // Second run must MISS — violations skipped save the first time.
        const second = await run({ ...opts, log: collectingLogger(fixture) })
        expect(second.outcomes[0]?.status).toBe('success')
      },
      TIMEOUT,
    )
  },
)

describe('sandbox-runtime probe', () => {
  it('returns a stable shape', async () => {
    const a = await probeSandbox()
    expect(typeof a.available).toBe('boolean')
    expect(typeof a.reason).toBe('string')
    if (a.available) expect(a.reason).toBe('')
    else expect(a.reason.length).toBeGreaterThan(0)
  })
})
