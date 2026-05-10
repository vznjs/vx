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
    'runs a task and caches the result',
    async () => {
      const dir = await addProject(fixture.root, 'app-a', {
        files: { 'src/index.txt': 'hello' },
        config: `
          export default {
            tasks: {
              stamp: {
                command: ${JSON.stringify(STAMP_CMD)},
                outputs: ['out.txt'],
              },
            },
          }
        `,
      })

      const first = await run({ cwd: fixture.root, task: 'stamp', log: silentLogger(fixture) })
      expect(first.ok).toBe(true)
      expect(first.outcomes[0]?.status).toBe('success')

      const stamp1 = await readFile(path.join(dir, 'out.txt'), 'utf8')

      const second = await run({ cwd: fixture.root, task: 'stamp', log: silentLogger(fixture) })
      expect(second.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(stamp1)
    },
    TIMEOUT,
  )

  it(
    'busts cache on any project file change',
    async () => {
      const dir = await addProject(fixture.root, 'app-b', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                command: ${JSON.stringify(STAMP_CMD)},
                outputs: ['out.txt'],
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      await new Promise((r) => setTimeout(r, 5))
      // Any project file change should bust cache; not just files under src/.
      await writeFile(path.join(dir, 'random.md'), 'newly added')

      const second = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(second.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(first)
    },
    TIMEOUT,
  )

  it(
    'does not self-invalidate when only its own outputs change',
    async () => {
      await addProject(fixture.root, 'app-self', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                command: ${JSON.stringify(STAMP_CMD)},
                outputs: ['out.txt'],
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r1.outcomes[0]?.status).toBe('success')
      // out.txt now exists in the project dir. A second run should still hit
      // the cache because declared outputs are excluded from inputs.
      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'invalidates a dependent when an upstream output changes',
    async () => {
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                command: "cat src/x.txt > dist.txt",
                outputs: ['dist.txt'],
              },
            },
          }
        `,
      })
      const appDir = await addProject(fixture.root, 'app', {
        deps: ['lib'],
        files: { 'src/y.txt': 'app' },
        config: `
          export default {
            tasks: {
              build: {
                command: ${JSON.stringify(STAMP_CMD)},
                dependsOn: [{ task: 'build', dependencies: true }],
                outputs: ['out.txt'],
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r1.ok).toBe(true)
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Re-run with no changes: both should hit cache.
      const r2 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      const appOutcome2 = r2.outcomes.find((o) => o.node.id === 'app#build')
      expect(appOutcome2?.status).toBe('cache-hit')

      // Change lib's source: its output changes -> app's cache must invalidate.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')

      const r3 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      const libOutcome3 = r3.outcomes.find((o) => o.node.id === 'lib#build')
      const appOutcome3 = r3.outcomes.find((o) => o.node.id === 'app#build')
      expect(libOutcome3?.status).toBe('success')
      expect(appOutcome3?.status).toBe('success')

      const appOut3 = await readFile(path.join(appDir, 'out.txt'), 'utf8')
      expect(appOut3).not.toBe(appOut1)
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
    'isolates the env: only declared vars (plus PATH-class essentials) reach the task',
    async () => {
      await addProject(fixture.root, 'envtest', {
        config: `
          export default {
            tasks: {
              show: {
                command: "node -e 'process.stdout.write([process.env.MY_VAR, process.env.SECRET_VAR].join(\\"|\\"))' > out.txt",
                env: ['MY_VAR'],
                outputs: ['out.txt'],
              },
            },
          }
        `,
      })

      // Set both vars in the parent; only MY_VAR should leak through.
      const prevMy = process.env.MY_VAR
      const prevSecret = process.env.SECRET_VAR
      process.env.MY_VAR = 'visible'
      process.env.SECRET_VAR = 'hidden'
      try {
        await run({ cwd: fixture.root, task: 'show', log: silentLogger(fixture) })
        const out = await readFile(
          path.join(fixture.root, 'packages/envtest/out.txt'),
          'utf8',
        )
        // SECRET_VAR was not declared so it must not reach the task; join
        // of [undefined] yields ''.
        expect(out).toBe('visible|')
      } finally {
        if (prevMy === undefined) delete process.env.MY_VAR
        else process.env.MY_VAR = prevMy
        if (prevSecret === undefined) delete process.env.SECRET_VAR
        else process.env.SECRET_VAR = prevSecret
      }
    },
    TIMEOUT,
  )

  it(
    'declared env value participates in cache key',
    async () => {
      await addProject(fixture.root, 'envcache', {
        config: `
          export default {
            tasks: {
              run: {
                command: "node -e 'process.stdout.write(process.env.MODE || \\"none\\")' > out.txt",
                env: ['MODE'],
                outputs: ['out.txt'],
              },
            },
          }
        `,
      })
      const projectDir = path.join(fixture.root, 'packages/envcache')

      process.env.MODE = 'a'
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      const a = await readFile(path.join(projectDir, 'out.txt'), 'utf8')

      process.env.MODE = 'b'
      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('success') // cache busted by MODE change
      const b = await readFile(path.join(projectDir, 'out.txt'), 'utf8')
      expect(b).not.toBe(a)
      delete process.env.MODE
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
                outputs: ['out.txt'],
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(existsSync(path.join(fixture.root, '.nxt', 'cache'))).toBe(true)
    },
    TIMEOUT,
  )
})
