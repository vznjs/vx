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
    deps?: Record<string, string>
    devDeps?: Record<string, string>
    files?: Record<string, string>
    config: string
  },
): Promise<string> {
  const safe = name.replace('@', '').replace('/', '-')
  const dir = path.join(root, 'packages', safe)
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: '0.0.0' }
  if (args.deps && Object.keys(args.deps).length > 0) pkg.dependencies = args.deps
  if (args.devDeps && Object.keys(args.devDeps).length > 0) pkg.devDependencies = args.devDeps
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
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { outputs: ['out.txt'] },
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
    'busts cache on any project file change (default inputs)',
    async () => {
      const dir = await addProject(fixture.root, 'app-b', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dir, 'random.md'), 'newly added')

      const second = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(second.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(first)
    },
    TIMEOUT,
  )

  it(
    'narrow inputs limit what busts the cache',
    async () => {
      const dir = await addProject(fixture.root, 'narrow', {
        files: { 'src/x.txt': 'v1', 'docs/README.md': 'docs' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: ['src/**'], outputs: ['out.txt'] },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })

      // Change a file outside src/. Cache should still hit.
      await writeFile(path.join(dir, 'docs/README.md'), 'docs v2')
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')

      // Change a file inside src/. Cache busts.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dir, 'src/x.txt'), 'v2')
      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'does not self-invalidate when only its declared outputs change',
    async () => {
      await addProject(fixture.root, 'app-self', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r1.outcomes[0]?.status).toBe('success')
      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'upstream cache-key change invalidates dependent (Turbo-style)',
    async () => {
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                process: { command: "cat src/x.txt > dist.txt" },
                cache: { outputs: ['dist.txt'] },
              },
            },
          }
        `,
      })
      const appDir = await addProject(fixture.root, 'app', {
        deps: { lib: 'workspace:*' },
        files: { 'src/y.txt': 'app' },
        config: `
          export default {
            tasks: {
              build: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: [{ task: 'build', dependencies: true }],
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r1.ok).toBe(true)
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      const r2 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')

      // Touch a file in lib that is NOT in lib's outputs. With Turbo-style
      // caching, lib's key changes, so app's key must change too.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/NOTES.md'), 'something')

      const r3 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r3.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      const appOut3 = await readFile(path.join(appDir, 'out.txt'), 'utf8')
      expect(appOut3).not.toBe(appOut1)
    },
    TIMEOUT,
  )

  it(
    'cache.dependencies: [] decouples the dependent from upstream cache',
    async () => {
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                process: { command: "cat src/x.txt > dist.txt" },
                cache: { outputs: ['dist.txt'] },
              },
            },
          }
        `,
      })
      const appDir = await addProject(fixture.root, 'app', {
        deps: { lib: 'workspace:*' },
        files: { 'src/y.txt': 'app' },
        config: `
          export default {
            tasks: {
              build: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: [{ task: 'build', dependencies: true }],
                cache: { outputs: ['out.txt'], dependencies: [] },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Change lib's source. App's cache should still hit because
      // app declared dependencies: [].
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')
      const r = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).toBe(appOut1)
    },
    TIMEOUT,
  )

  it(
    'env input affects the cache key; passThroughEnv does not',
    async () => {
      await addProject(fixture.root, 'envproj', {
        config: `
          export default {
            tasks: {
              show: {
                process: {
                  command: "node -e 'process.stdout.write([process.env.CACHED, process.env.PASSED].join(\\":\\"))' > out.txt",
                  passThroughEnv: ['CACHED', 'PASSED'],
                },
                cache: {
                  inputs: [{ env: 'CACHED' }],
                  outputs: ['out.txt'],
                },
              },
            },
          }
        `,
      })
      const dir = path.join(fixture.root, 'packages/envproj')

      process.env.CACHED = 'a'
      process.env.PASSED = '1'
      await run({ cwd: fixture.root, task: 'show', log: silentLogger(fixture) })
      const a = await readFile(path.join(dir, 'out.txt'), 'utf8')
      expect(a).toBe('a:1')

      // Change PASSED only. Not declared as an env input -> cache hits, the
      // restored out.txt still says "a:1".
      process.env.PASSED = '2'
      const r2 = await run({ cwd: fixture.root, task: 'show', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('a:1')

      // Change CACHED. It IS declared as input -> cache busts, new value reaches the task.
      process.env.CACHED = 'b'
      const r3 = await run({ cwd: fixture.root, task: 'show', log: silentLogger(fixture) })
      expect(r3.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('b:2')

      delete process.env.CACHED
      delete process.env.PASSED
    },
    TIMEOUT,
  )

  it(
    'process.env explicit values reach the child and participate in cache',
    async () => {
      await addProject(fixture.root, 'explicit', {
        config: `
          export default {
            tasks: {
              show: {
                process: {
                  command: "node -e 'process.stdout.write(process.env.MODE)' > out.txt",
                  env: { MODE: 'one' },
                },
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      })
      const dir = path.join(fixture.root, 'packages/explicit')
      await run({ cwd: fixture.root, task: 'show', log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('one')

      // Rewrite config with a different MODE value.
      await writeFile(
        path.join(dir, 'nxt.config.mjs'),
        `
          export default {
            tasks: {
              show: {
                process: {
                  command: "node -e 'process.stdout.write(process.env.MODE)' > out.txt",
                  env: { MODE: 'two' },
                },
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      )
      const r = await run({ cwd: fixture.root, task: 'show', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('two')
    },
    TIMEOUT,
  )

  it(
    'externalDependencies input changes bust the cache',
    async () => {
      const dir = await addProject(fixture.root, 'extdeps', {
        devDeps: { typescript: '^5.0.0' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: {
                  inputs: [{ externalDependencies: ['typescript'] }],
                  outputs: ['out.txt'],
                },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')

      // Bump typescript range; cache busts.
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
        devDependencies: Record<string, string>
      }
      pkg.devDependencies.typescript = '^5.6.0'
      await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))

      const r3 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r3.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(first)
    },
    TIMEOUT,
  )

  it(
    'workspace input invalidates when a workspace-root file changes',
    async () => {
      await writeFile(path.join(fixture.root, 'tsconfig.base.json'), '{"v":1}')
      const dir = await addProject(fixture.root, 'ws', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: {
                  inputs: [{ default: true }, { workspace: 'tsconfig.base.json' }],
                  outputs: ['out.txt'],
                },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      await writeFile(path.join(fixture.root, 'tsconfig.base.json'), '{"v":2}')
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(first)
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
              build: {
                process: { command: "exit 7" },
                cache: { enabled: false },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app', {
        deps: { lib: 'workspace:*' },
        config: `
          export default {
            tasks: {
              build: {
                process: { command: "echo should-not-run" },
                dependsOn: [{ task: 'build', dependencies: true }],
                cache: { enabled: false },
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
    'undeclared env vars do not leak to the child',
    async () => {
      await addProject(fixture.root, 'iso', {
        config: `
          export default {
            tasks: {
              show: {
                process: {
                  command: "node -e 'process.stdout.write(String(process.env.LEAK))' > out.txt",
                },
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      })
      process.env.LEAK = 'should-not-pass'
      try {
        await run({ cwd: fixture.root, task: 'show', log: silentLogger(fixture) })
        const out = await readFile(
          path.join(fixture.root, 'packages/iso/out.txt'),
          'utf8',
        )
        expect(out).toBe('undefined')
      } finally {
        delete process.env.LEAK
      }
    },
    TIMEOUT,
  )

  it(
    'creates the cache directory under workspace root',
    async () => {
      await addProject(fixture.root, 'app-f', {
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { outputs: ['out.txt'] },
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
