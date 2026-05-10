import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Logger } from './orchestrator.js'
import { run } from './orchestrator.js'

interface Fixture {
  root: string
  log: string[]
  err: string[]
}

const TIMEOUT = 30_000

const silentLogger = (fixture: Fixture): Logger => ({
  status(line) {
    fixture.log.push(line)
  },
  taskStdout(_n, chunk) {
    fixture.log.push(chunk.trimEnd())
  },
  taskStderr(_n, chunk) {
    fixture.err.push(chunk.trimEnd())
  },
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  return { root, log: [], err: [] }
}

async function addProject(
  root: string,
  name: string,
  args: {
    deps?: string[]
    files?: Record<string, string>
    config: string
  },
): Promise<string> {
  const safe = name.replace('@', '').replace('/', '-')
  const dir = path.join(root, 'packages', safe)
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: '0.0.0' }
  if (args.deps && args.deps.length > 0) {
    pkg.dependencies = Object.fromEntries(args.deps.map((d) => [d, 'workspace:*']))
  }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  await writeFile(path.join(dir, 'nxt.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
}

const STAMP_CMD = `node -e 'process.stdout.write(String(Date.now()))' > out.txt`

describe('orchestrator e2e', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'runs a single task and caches the result',
    async () => {
      const projectDir = await addProject(fixture.root, 'app-a', {
        files: { 'src/index.txt': 'hello' },
        config: `
          export default {
            tasks: {
              stamp: {
                command: ${JSON.stringify(STAMP_CMD)},
                cache: { inputs: ['src/**/*'], outputs: ['out.txt'] },
              },
            },
          }
        `,
      })

      const first = await run({ cwd: fixture.root, task: 'stamp', log: silentLogger(fixture) })
      expect(first.ok).toBe(true)
      expect(first.outcomes).toHaveLength(1)
      expect(first.outcomes[0]?.status).toBe('success')

      const stamp1 = await readFile(path.join(projectDir, 'out.txt'), 'utf8')

      const second = await run({ cwd: fixture.root, task: 'stamp', log: silentLogger(fixture) })
      expect(second.outcomes[0]?.status).toBe('cache-hit')

      const stamp2 = await readFile(path.join(projectDir, 'out.txt'), 'utf8')
      expect(stamp2).toBe(stamp1)
    },
    TIMEOUT,
  )

  it(
    'busts cache when input changes',
    async () => {
      const dir = await addProject(fixture.root, 'app-b', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                command: ${JSON.stringify(STAMP_CMD)},
                cache: { inputs: ['src/**/*'], outputs: ['out.txt'] },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dir, 'src/x.txt'), 'v2')

      const second = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(second.outcomes[0]?.status).toBe('success')
      const after = await readFile(path.join(dir, 'out.txt'), 'utf8')
      expect(after).not.toBe(first)
    },
    TIMEOUT,
  )

  it(
    'runs upstream task before dependent across workspace deps',
    async () => {
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'lib' },
        config: `
          export default {
            tasks: {
              build: {
                command: "echo lib > order.txt",
                cache: { inputs: ['src/**/*'], outputs: ['order.txt'] },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app', {
        deps: ['lib'],
        files: { 'src/x.txt': 'app' },
        config: `
          export default {
            tasks: {
              build: {
                command: "echo app > order.txt",
                dependsOn: [{ task: 'build', dependencies: true }],
                cache: { inputs: ['src/**/*'], outputs: ['order.txt'] },
              },
            },
          }
        `,
      })

      const result = await run({
        cwd: fixture.root,
        task: 'build',
        concurrency: 1,
        log: silentLogger(fixture),
      })
      expect(result.ok).toBe(true)
      const ids = result.outcomes.map((o) => o.node.id)
      expect(ids.indexOf('lib#build')).toBeLessThan(ids.indexOf('app#build'))
    },
    TIMEOUT,
  )

  it(
    'fails the dependent when an upstream task fails',
    async () => {
      await addProject(fixture.root, 'lib', {
        config: `
          export default {
            tasks: {
              build: { command: "exit 7", cache: false },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app', {
        deps: ['lib'],
        config: `
          export default {
            tasks: {
              build: {
                command: "echo should-not-run",
                dependsOn: [{ task: 'build', dependencies: true }],
                cache: false,
              },
            },
          }
        `,
      })

      const result = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(result.ok).toBe(false)
      const lib = result.outcomes.find((o) => o.node.id === 'lib#build')
      const app = result.outcomes.find((o) => o.node.id === 'app#build')
      expect(lib?.status).toBe('failed')
      expect(app?.status).toBe('skipped')
    },
    TIMEOUT,
  )

  it(
    'creates the cache directory under workspace root',
    async () => {
      await addProject(fixture.root, 'app-f', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                command: ${JSON.stringify(STAMP_CMD)},
                cache: { inputs: ['src/**/*'], outputs: ['out.txt'] },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      await run({ cwd: fixture.root, task: 'run', force: true, log: silentLogger(fixture) })
      expect(existsSync(path.join(fixture.root, '.nxt', 'cache'))).toBe(true)
    },
    TIMEOUT,
  )
})
