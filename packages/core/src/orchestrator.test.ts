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
                cache: { inputs: { files: ['src/**'] }, outputs: ['out.txt'] },
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
                dependsOn: { dependencies: ['build'] },
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
    'cache.inputs.tasks: [] decouples the dependent from upstream cache',
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
                dependsOn: { dependencies: ['build'] },
                cache: {
                  outputs: ['out.txt'],
                  inputs: { tasks: [] },
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Change lib's source. App's cache should still hit because
      // app declared tasks: [].
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
                  inputs: { env: ['CACHED'] },
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
    'cache.inputs.tasks pattern: ["*", "!noisy"] excludes noisy from key',
    async () => {
      // lib has two unrelated tasks with narrow, non-overlapping inputs.
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1', 'noisy-src/n.txt': 'a' },
        config: `
          export default {
            tasks: {
              build: {
                process: { command: "cat src/x.txt > dist.txt" },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: ['dist.txt'],
                },
              },
              noisy: {
                process: { command: "cat noisy-src/n.txt > noisy-out.txt" },
                cache: {
                  inputs: { files: ['noisy-src/**'] },
                  outputs: ['noisy-out.txt'],
                },
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
                dependsOn: { dependencies: ['build', 'noisy'] },
                cache: {
                  outputs: ['out.txt'],
                  inputs: { tasks: ['*', '!noisy'] },
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Change lib's noisy source. lib#noisy reruns; lib#build cache-hits.
      // app filters out noisy, so app's key is unchanged -> app cache-hits.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/noisy-src/n.txt'), 'b')

      const r = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r.outcomes.find((o) => o.node.id === 'lib#noisy')?.status).toBe('success')
      expect(r.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('cache-hit')
      expect(r.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).toBe(appOut1)

      // Sanity: change lib's *build* source. lib#build's key changes.
      // Since `build` is included in dependencies, app must rerun.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')

      const r2 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).not.toBe(appOut1)
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
                dependsOn: { dependencies: ['build'] },
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
    'project boundary: nested project files do not leak into parent inputs',
    async () => {
      // Make the workspace root itself a project, with packages/* as children.
      await writeFile(
        path.join(fixture.root, 'pnpm-workspace.yaml'),
        'packages:\n  - .\n  - "packages/*"\n',
      )
      await writeFile(
        path.join(fixture.root, 'package.json'),
        JSON.stringify({ name: 'root-proj', version: '0.0.0' }, null, 2),
      )
      await writeFile(
        path.join(fixture.root, 'nxt.config.mjs'),
        `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      )
      await mkdir(path.join(fixture.root, 'src'), { recursive: true })
      await writeFile(path.join(fixture.root, 'src/root.txt'), 'root v1')

      // Nested project under packages/inner with cache disabled — so its files
      // are pure noise from the root project's perspective.
      await addProject(fixture.root, 'inner', {
        files: { 'src/inner.txt': 'inner v1' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: "echo inner" },
              },
            },
          }
        `,
      })

      await run({
        cwd: fixture.root,
        task: 'run',
        projects: ['root-proj'],
        log: silentLogger(fixture),
      })
      const first = await readFile(path.join(fixture.root, 'out.txt'), 'utf8')

      // 1. Changing a file inside the nested project must NOT bust root's cache.
      await writeFile(
        path.join(fixture.root, 'packages/inner/src/inner.txt'),
        'inner v2',
      )
      const r2 = await run({
        cwd: fixture.root,
        task: 'run',
        projects: ['root-proj'],
        log: silentLogger(fixture),
      })
      expect(r2.outcomes.find((o) => o.node.id === 'root-proj#run')?.status).toBe('cache-hit')
      expect(await readFile(path.join(fixture.root, 'out.txt'), 'utf8')).toBe(first)

      // 2. Changing a file inside the parent's own src/ MUST bust root's cache.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'src/root.txt'), 'root v2')
      const r3 = await run({
        cwd: fixture.root,
        task: 'run',
        projects: ['root-proj'],
        log: silentLogger(fixture),
      })
      expect(r3.outcomes.find((o) => o.node.id === 'root-proj#run')?.status).toBe('success')
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

  it(
    'non-zero exit code is NOT cached; next run re-executes',
    async () => {
      const dir = await addProject(fixture.root, 'fail', {
        config: `
          export default {
            tasks: {
              run: {
                process: {
                  command: "node -e 'require(\\"fs\\").appendFileSync(\\"runs.txt\\", \\"x\\"); process.exit(3)'",
                },
                cache: { outputs: ['runs.txt'] },
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r1.outcomes[0]?.status).toBe('failed')
      expect(r1.outcomes[0]?.exitCode).toBe(3)

      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('failed')
      // The command ran a second time -> "xx" in runs.txt.
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('xx')
    },
    TIMEOUT,
  )

  it(
    '--force re-runs even on a cache hit',
    async () => {
      const dir = await addProject(fixture.root, 'forced', {
        config: `
          export default {
            tasks: {
              run: {
                process: {
                  command: "node -e 'require(\\"fs\\").appendFileSync(\\"runs.txt\\", \\"x\\")'",
                },
                cache: { outputs: ['runs.txt'] },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      const after1 = await readFile(path.join(dir, 'runs.txt'), 'utf8')
      expect(after1).toBe('x')

      // Without --force: cache-hit, file restored as-is.
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')

      // With --force: command runs again, appends another 'x'.
      await run({ cwd: fixture.root, task: 'run', force: true, log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('xx')
    },
    TIMEOUT,
  )

  it(
    'omitting `cache` makes the task always re-run (no read/write)',
    async () => {
      const dir = await addProject(fixture.root, 'nocache', {
        config: `
          export default {
            tasks: {
              run: {
                process: {
                  command: "node -e 'require(\\"fs\\").appendFileSync(\\"runs.txt\\", \\"x\\")'",
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('xxx')
    },
    TIMEOUT,
  )

  it(
    'restores a deleted output file on a cache hit',
    async () => {
      const dir = await addProject(fixture.root, 'restore', {
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
      const original = await readFile(path.join(dir, 'out.txt'), 'utf8')

      await rm(path.join(dir, 'out.txt'))
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(original)
    },
    TIMEOUT,
  )

  it(
    'restores multiple output files declared via globs',
    async () => {
      const dir = await addProject(fixture.root, 'multi-out', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                process: {
                  command: "mkdir -p dist && echo a > dist/a.txt && echo b > dist/b.txt && echo c > dist/c.txt",
                },
                cache: { outputs: ['dist/**'] },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      await rm(path.join(dir, 'dist'), { recursive: true })

      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'dist/a.txt'), 'utf8')).toBe('a\n')
      expect(await readFile(path.join(dir, 'dist/b.txt'), 'utf8')).toBe('b\n')
      expect(await readFile(path.join(dir, 'dist/c.txt'), 'utf8')).toBe('c\n')
    },
    TIMEOUT,
  )

  it(
    'declared output that the task did not produce does not fail the run',
    async () => {
      await addProject(fixture.root, 'maybe', {
        config: `
          export default {
            tasks: {
              run: {
                process: { command: "echo nothing-produced" },
                cache: { outputs: ['out.txt', 'dist/**'] },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]?.status).toBe('success')

      // Second run still hits cache; nothing to restore is fine.
      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'gitignored files do not contribute to the default input set',
    async () => {
      const dir = await addProject(fixture.root, 'gi', {
        files: {
          '.gitignore': 'ignored.txt\n',
          'src/x.txt': 'v1',
          'ignored.txt': 'v1',
        },
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
      // Modify the gitignored file. Cache should still hit.
      await writeFile(path.join(dir, 'ignored.txt'), 'changed')
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'negation glob in inputs excludes matched files from the cache key',
    async () => {
      const dir = await addProject(fixture.root, 'neg', {
        files: { 'src/keep.txt': 'a', 'src/skip.txt': 'a' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['src/**', '!src/skip.txt'] }, outputs: ['out.txt'] },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })

      // Touching src/skip.txt should NOT bust the cache (excluded by negation).
      await writeFile(path.join(dir, 'src/skip.txt'), 'b')
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')

      // Touching src/keep.txt SHOULD bust.
      await writeFile(path.join(dir, 'src/keep.txt'), 'b')
      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    "composing '**/*' with negation works as union-then-subtract",
    async () => {
      const dir = await addProject(fixture.root, 'compose', {
        files: { 'src/x.txt': 'v1', 'noisy.log': 'a' },
        config: `
          export default {
            tasks: {
              run: {
                process: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*', '!noisy.log'] }, outputs: ['out.txt'] },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      await writeFile(path.join(dir, 'noisy.log'), 'b')
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')

      await writeFile(path.join(dir, 'src/x.txt'), 'v2')
      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'no project declares the requested task: returns ok with zero outcomes',
    async () => {
      await addProject(fixture.root, 'lonely', {
        config: `
          export default {
            tasks: {
              build: {
                process: { command: "echo only-build" },
                cache: { outputs: [] },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, task: 'nonexistent', log: silentLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(r.outcomes).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'package without nxt.config is discovered but contributes no tasks',
    async () => {
      // Project A has tasks; project B exists in pnpm workspace but has no config.
      await addProject(fixture.root, 'has-config', {
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
      // Bare package without nxt.config:
      const bareDir = path.join(fixture.root, 'packages/bare')
      await mkdir(bareDir, { recursive: true })
      await writeFile(
        path.join(bareDir, 'package.json'),
        JSON.stringify({ name: 'bare', version: '0.0.0' }, null, 2),
      )

      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes.map((o) => o.node.projectName)).toEqual(['has-config'])
      expect(r.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'cache hit replays both stdout and stderr',
    async () => {
      await addProject(fixture.root, 'logs', {
        config: `
          export default {
            tasks: {
              run: {
                process: {
                  command: "node -e 'process.stdout.write(\\"OUT\\\\n\\"); process.stderr.write(\\"ERR\\\\n\\")'",
                },
                cache: { outputs: [] },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      // Reset the logger so we capture only the second (cache-hit) invocation.
      fixture.log = []
      fixture.err = []
      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
      expect(fixture.log.join('\n')).toContain('OUT')
      expect(fixture.err.join('\n')).toContain('ERR')
    },
    TIMEOUT,
  )

  it(
    'upstream env-input change invalidates dependent (Turbo-style propagation, env edition)',
    async () => {
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                process: { command: "cat src/x.txt > dist.txt" },
                cache: {
                  inputs: { env: ['API_URL'] },
                  outputs: ['dist.txt'],
                },
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
                dependsOn: { dependencies: ['build'] },
                cache: { outputs: ['out.txt'] },
              },
            },
          }
        `,
      })

      process.env.API_URL = 'https://a.example'
      await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Same env: both should hit cache.
      const r2 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(r2.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('cache-hit')

      // Change API_URL: lib's env input changes -> lib reruns -> app's
      // upstream hash changes -> app must rerun even though no file changed
      // anywhere.
      process.env.API_URL = 'https://b.example'
      const r3 = await run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) })
      expect(r3.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('success')
      expect(r3.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).not.toBe(appOut1)

      delete process.env.API_URL
    },
    TIMEOUT,
  )

  it(
    'workspace fingerprint: pnpm-lock.yaml change busts every task cache',
    async () => {
      // Seed a lockfile.
      await writeFile(
        path.join(fixture.root, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nimporters:\n  '.': {}\n",
      )
      const dir = await addProject(fixture.root, 'lockproj', {
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

      // Same lockfile -> cache hits.
      const r1 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r1.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(first)

      // Lockfile changes (e.g. transitive resolution bump). No project file
      // changed; cache must still bust because workspaceFingerprint differs.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(
        path.join(fixture.root, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nimporters:\n  '.': {}\n# bumped\n",
      )

      const r2 = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(first)
    },
    TIMEOUT,
  )

  it(
    'config-only change busts cache even when narrow inputs exclude the config file',
    async () => {
      // Narrow files to `src/**` only — the config file itself is NOT in the
      // input set. The cache must still invalidate when the config changes,
      // via the resolved task-config hash.
      const dir = await addProject(fixture.root, 'cfgchange', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                process: {
                  command: ${JSON.stringify(STAMP_CMD)},
                  passThroughEnv: ['ONE'],
                },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: ['out.txt'],
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })

      // Edit only the config file. It's outside `src/**` so file inputs are
      // unchanged. taskConfigHash differs -> cache must bust.
      await writeFile(
        path.join(dir, 'nxt.config.mjs'),
        `
          export default {
            tasks: {
              run: {
                process: {
                  command: ${JSON.stringify(STAMP_CMD)},
                  passThroughEnv: ['ONE', 'TWO'],
                },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: ['out.txt'],
                },
              },
            },
          }
        `,
      )

      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'duplicate package names across workspace globs error clearly',
    async () => {
      // Two packages claiming the same name.
      await mkdir(path.join(fixture.root, 'packages/a'), { recursive: true })
      await mkdir(path.join(fixture.root, 'packages/b'), { recursive: true })
      await writeFile(
        path.join(fixture.root, 'packages/a/package.json'),
        JSON.stringify({ name: 'dup', version: '0.0.0' }),
      )
      await writeFile(
        path.join(fixture.root, 'packages/b/package.json'),
        JSON.stringify({ name: 'dup', version: '0.0.0' }),
      )

      await expect(
        run({ cwd: fixture.root, task: 'build', log: silentLogger(fixture) }),
      ).rejects.toThrow(/Duplicate package name "dup"/)
    },
    TIMEOUT,
  )

  it(
    'mtime-only edits to the same content do not bust the cache',
    async () => {
      const dir = await addProject(fixture.root, 'mtime', {
        files: { 'src/x.txt': 'same' },
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

      await new Promise((r) => setTimeout(r, 10))
      // Rewrite identical content so mtime advances but content hash is the same.
      await writeFile(path.join(dir, 'src/x.txt'), 'same')

      const r = await run({ cwd: fixture.root, task: 'run', log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )
})
