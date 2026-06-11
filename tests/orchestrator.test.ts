import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

interface Fixture {
  root: string
  log: string[]
  err: string[]
}

const TIMEOUT = 30_000

const silentLogger = (fixture: Fixture): Logger => {
  const buffers = new Map<string, string>()
  return {
    status(line) {
      fixture.log.push(line)
    },
    taskStdout(node, chunk) {
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskStderr(node, chunk) {
      // Tee stderr to fixture.err for tests that assert on it
      // separately, AND into the per-task body buffer so taskComplete
      // surfaces it in `fixture.log` (matches defaultLogger, which
      // merges streams into a single framed block).
      fixture.err.push(chunk.trimEnd())
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskComplete(node, outcome) {
      const body = buffers.get(node.id) ?? ''
      buffers.delete(node.id)
      // Marker line carries the task id + status so tests that grep
      // `fixture.log` for the id (the only way they used to detect
      // task progress) keep working without coupling to the exact
      // framed-output format.
      fixture.log.push(`task ${node.id} ${outcome.status}`)
      if (body.trim().length > 0) fixture.log.push(body.trimEnd())
    },
  }
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nxt-e2e-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  // vx requires git (it asks `git ls-files` for the input file set).
  // Init a quiet repo so the orchestrator can enumerate fixture files.
  initGitRepo(root)
  return { root, log: [], err: [] }
}

function initGitRepo(cwd: string): void {
  const run = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
  run('init', '-q')
  run('config', 'user.email', 'test@vx.local')
  run('config', 'user.name', 'vx test')
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
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const first = await run({ cwd: fixture.root, tasks: ['stamp'], log: silentLogger(fixture) })
      expect(first.ok).toBe(true)
      expect(first.outcomes[0]?.status).toBe('success')

      const stamp1 = await readFile(path.join(dir, 'out.txt'), 'utf8')
      const second = await run({ cwd: fixture.root, tasks: ['stamp'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dir, 'random.md'), 'newly added')

      const second = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })

      // Change a file outside src/. Cache should still hit.
      await writeFile(path.join(dir, 'docs/README.md'), 'docs v2')
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')

      // Change a file inside src/. Cache busts.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dir, 'src/x.txt'), 'v2')
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r1.outcomes[0]?.status).toBe('success')
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: "cat src/x.txt > dist.txt" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['dist.txt'] } },
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['^build'],
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r1.ok).toBe(true)
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      const r2 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')

      // Touch a file in lib that is NOT in lib's outputs. With Turbo-style
      // caching, lib's key changes, so app's key must change too.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/NOTES.md'), 'something')

      const r3 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
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
                exec: { command: "cat src/x.txt > dist.txt" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['dist.txt'] } },
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['^build'],
                cache: {
                  outputs: { files: ['out.txt'] },
                  inputs: { files: ['**/*'], tasks: [] },
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Change lib's source. App's cache should still hit because
      // app declared tasks: [].
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).toBe(appOut1)
    },
    TIMEOUT,
  )

  it(
    'cache.inputs.env affects the cache key; exec.env.passThrough alone does not',
    async () => {
      await addProject(fixture.root, 'envproj', {
        config: `
          export default {
            tasks: {
              show: {
                exec: {
                  command: "node -e 'process.stdout.write([process.env.CACHED, process.env.PASSED].join(\\":\\"))' > out.txt",
                  env: { passThrough: ['CACHED', 'PASSED'] },
                },
                cache: {
                  inputs: { files: ['**/*'], env: ['CACHED'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      const dir = path.join(fixture.root, 'packages/envproj')

      process.env.CACHED = 'a'
      process.env.PASSED = '1'
      await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
      const a = await readFile(path.join(dir, 'out.txt'), 'utf8')
      expect(a).toBe('a:1')

      // Change PASSED only. Not declared as an env input -> cache hits, the
      // restored out.txt still says "a:1".
      process.env.PASSED = '2'
      const r2 = await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('a:1')

      // Change CACHED. It IS declared as input -> cache busts, new value reaches the task.
      process.env.CACHED = 'b'
      const r3 = await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
      expect(r3.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('b:2')

      delete process.env.CACHED
      delete process.env.PASSED
    },
    TIMEOUT,
  )

  it(
    'exec.env.define values reach the child and participate in the cache key',
    async () => {
      await addProject(fixture.root, 'explicit', {
        config: `
          export default {
            tasks: {
              show: {
                exec: {
                  command: "node -e 'process.stdout.write(process.env.MODE)' > out.txt",
                  env: { define: { MODE: 'one' } },
                },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const dir = path.join(fixture.root, 'packages/explicit')
      await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('one')

      // Rewrite config with a different MODE value.
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `
          export default {
            tasks: {
              show: {
                exec: {
                  command: "node -e 'process.stdout.write(process.env.MODE)' > out.txt",
                  env: { define: { MODE: 'two' } },
                },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      )
      const r = await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('two')
    },
    TIMEOUT,
  )

  it(
    "cache.inputs.tasks: ['^build'] picks just one upstream task name",
    async () => {
      // lib has two unrelated tasks with narrow, non-overlapping inputs.
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1', 'noisy-src/n.txt': 'a' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "cat src/x.txt > dist.txt" },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: { files: ['dist.txt'] },
                },
              },
              noisy: {
                exec: { command: "cat noisy-src/n.txt > noisy-out.txt" },
                cache: {
                  inputs: { files: ['noisy-src/**'] },
                  outputs: { files: ['noisy-out.txt'] },
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['^build', '^noisy'],
                cache: {
                  outputs: { files: ['out.txt'] },
                  inputs: { files: ['**/*'], tasks: ['^build'] },
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Change lib's noisy source. lib#noisy reruns; lib#build cache-hits.
      // app filters out noisy, so app's key is unchanged -> app cache-hits.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/noisy-src/n.txt'), 'b')

      const r = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r.outcomes.find((o) => o.node.id === 'lib#noisy')?.status).toBe('success')
      expect(r.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('cache-hit')
      expect(r.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).toBe(appOut1)

      // Sanity: change lib's *build* source. lib#build's key changes.
      // Since `build` is included in dependencies, app must rerun.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')

      const r2 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).not.toBe(appOut1)
    },
    TIMEOUT,
  )

  it(
    'cache.inputs.tasks per-bucket default: overriding self leaves dependencies on default-all',
    async () => {
      // lib has a `build` task — workspace dep upstream.
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "cat src/x.txt > dist.txt" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['dist.txt'] } },
              },
            },
          }
        `,
      })

      // app has `codegen` (self) AND a workspace dep on lib's build.
      // Its `build` filters self to ['codegen'] but DOESN'T set dependencies
      // -> dependencies bucket should default to all-of-deps' build.
      const appDir = await addProject(fixture.root, 'app', {
        deps: { lib: 'workspace:*' },
        files: { 'src/y.txt': 'app' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: "echo gen > generated.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
              },
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['codegen', '^build'],
                cache: {
                  inputs: {
                    files: ['**/*'],
                    tasks: ['codegen', '^*'],   // explicit self + all deps
                  },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Re-run unchanged: cache hit.
      const r2 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')

      // Change lib's source. Because `dependencies` bucket is omitted, lib#build
      // hash should still flow through and bust app#build.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')

      const r3 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r3.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).not.toBe(appOut1)
    },
    TIMEOUT,
  )

  it(
    "cache.inputs.tasks supports '*' and '!name' patterns inside a bucket",
    async () => {
      // lib has two tasks with non-overlapping narrow inputs so we can
      // change one without disturbing the other.
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1', 'noisy-src/n.txt': 'a' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "cat src/x.txt > dist.txt" },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: { files: ['dist.txt'] },
                },
              },
              noisy: {
                exec: { command: "cat noisy-src/n.txt > noisy-out.txt" },
                cache: {
                  inputs: { files: ['noisy-src/**'] },
                  outputs: { files: ['noisy-out.txt'] },
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['^build', '^noisy'],
                cache: {
                  inputs: {
                    files: ['**/*'],
                    tasks: ['^*', '!^noisy'],
                  },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Change lib's noisy source. lib#noisy reruns; lib#build cache-hits.
      // app excluded noisy via '!noisy', so app#build cache-hits too.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/noisy-src/n.txt'), 'b')

      const r2 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).toBe(appOut1)

      // Change lib's build source. '*' matches build, app#build invalidates.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')

      const r3 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r3.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
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
                exec: { command: "exit 7" },
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
                exec: { command: "echo should-not-run" },
                dependsOn: ['^build'],
              },
            },
          }
        `,
      })

      const result = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
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
                exec: {
                  command: "node -e 'process.stdout.write(String(process.env.LEAK))' > out.txt",
                },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      process.env.LEAK = 'should-not-pass'
      try {
        await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
        const out = await readFile(path.join(fixture.root, 'packages/iso/out.txt'), 'utf8')
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
        path.join(fixture.root, 'vx.config.mjs'),
        `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
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
                exec: { command: "echo inner" },
              },
            },
          }
        `,
      })

      await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['root-proj'],
        log: silentLogger(fixture),
      })
      const first = await readFile(path.join(fixture.root, 'out.txt'), 'utf8')

      // 1. Changing a file inside the nested project must NOT bust root's cache.
      await writeFile(path.join(fixture.root, 'packages/inner/src/inner.txt'), 'inner v2')
      const r2 = await run({
        cwd: fixture.root,
        tasks: ['run'],
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
        tasks: ['run'],
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(existsSync(path.join(fixture.root, '.vx', 'cache'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'non-zero exit code is NOT cached; next run re-executes',
    async () => {
      // The exec-run counter lives outside `cache.outputs.files` so
      // cleanOutputs() doesn't wipe it between runs. It's only used to
      // confirm the task body actually re-executed.
      const dir = await addProject(fixture.root, 'fail', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: {
                  command: "node -e 'require(\\"fs\\").appendFileSync(\\"runs.txt\\", \\"x\\"); process.exit(3)'",
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })

      const r1 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r1.outcomes[0]?.status).toBe('failed')
      expect(r1.outcomes[0]?.exitCode).toBe(3)

      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('failed')
      // The command ran a second time -> "xx" in runs.txt.
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('xx')
    },
    TIMEOUT,
  )

  it(
    '--no-cache skips reads AND writes, re-running on every invocation',
    async () => {
      const dir = await addProject(fixture.root, 'forced', {
        config: `
          export default {
            tasks: {
              run: {
                exec: {
                  command: "node -e 'require(\\"fs\\").appendFileSync(\\"runs.txt\\", \\"x\\")'",
                },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['runs.txt'] } },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const after1 = await readFile(path.join(dir, 'runs.txt'), 'utf8')
      expect(after1).toBe('x')

      // Without --no-cache: cache-hit, file restored as-is.
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')

      // With --no-cache: command runs again, appends another 'x'.
      await run({ cwd: fixture.root, tasks: ['run'], noCache: true, log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('xx')

      // --no-cache also skipped the WRITE: the next default run sees the
      // previously-cached entry (from the first run) and restores it,
      // overwriting the file back to 'x'.
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')
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
                exec: {
                  command: "node -e 'require(\\"fs\\").appendFileSync(\\"runs.txt\\", \\"x\\")'",
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const original = await readFile(path.join(dir, 'out.txt'), 'utf8')

      await rm(path.join(dir, 'out.txt'))
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: {
                  command: "mkdir -p dist && echo a > dist/a.txt && echo b > dist/b.txt && echo c > dist/c.txt",
                },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      await rm(path.join(dir, 'dist'), { recursive: true })

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: "echo nothing-produced" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt', 'dist/**'] } },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]?.status).toBe('success')

      // Second run still hits cache; nothing to restore is fine.
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      // Modify the gitignored file. Cache should still hit.
      await writeFile(path.join(dir, 'ignored.txt'), 'changed')
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['src/**', '!src/skip.txt'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })

      // Touching src/skip.txt should NOT bust the cache (excluded by negation).
      await writeFile(path.join(dir, 'src/skip.txt'), 'b')
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')

      // Touching src/keep.txt SHOULD bust.
      await writeFile(path.join(dir, 'src/keep.txt'), 'b')
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*', '!noisy.log'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      await writeFile(path.join(dir, 'noisy.log'), 'b')
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')

      await writeFile(path.join(dir, 'src/x.txt'), 'v2')
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'no project declares the requested task: returns NOT-ok with zero outcomes',
    async () => {
      // Treating a typo'd task name as success would silently no-op
      // entire CI scripts. Real-world test (Agent A, bug B3) caught this.
      await addProject(fixture.root, 'lonely', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "echo only-build" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['nonexistent'], log: silentLogger(fixture) })
      expect(r.ok).toBe(false)
      expect(r.outcomes).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'package without vx.config is discovered but contributes no tasks',
    async () => {
      // Project A has tasks; project B exists in pnpm workspace but has no config.
      await addProject(fixture.root, 'has-config', {
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      // Bare package without vx.config:
      const bareDir = path.join(fixture.root, 'packages/bare')
      await mkdir(bareDir, { recursive: true })
      await writeFile(
        path.join(bareDir, 'package.json'),
        JSON.stringify({ name: 'bare', version: '0.0.0' }, null, 2),
      )

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes.map((o) => o.node.projectName)).toEqual(['has-config'])
      expect(r.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'cache hit replays stdout (stderr is not cached)',
    async () => {
      await addProject(fixture.root, 'logs', {
        config: `
          export default {
            tasks: {
              run: {
                exec: {
                  command: "node -e 'process.stdout.write(\\"OUT\\\\n\\"); process.stderr.write(\\"ERR\\\\n\\")'",
                },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      // Reset the logger so we capture only the second (cache-hit) invocation.
      fixture.log = []
      fixture.err = []
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
      // stdout is replayed from the artifact's `stdout` entry...
      expect(fixture.log.join('\n')).toContain('OUT')
      // ...but stderr is intentionally not cached. We only cache
      // successful runs, so stderr is rarely meaningful on replay.
      expect(fixture.err.join('\n')).not.toContain('ERR')
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
                exec: { command: "cat src/x.txt > dist.txt" },
                cache: {
                  inputs: { files: ['**/*'], env: ['API_URL'] },
                  outputs: { files: ['dist.txt'] },
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['^build'],
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      process.env.API_URL = 'https://a.example'
      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      const appOut1 = await readFile(path.join(appDir, 'out.txt'), 'utf8')

      // Same env: both should hit cache.
      const r2 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(r2.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('cache-hit')

      // Change API_URL: lib's env input changes -> lib reruns -> app's
      // upstream hash changes -> app must rerun even though no file changed
      // anywhere.
      process.env.API_URL = 'https://b.example'
      const r3 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      // Same lockfile -> cache hits.
      const r1 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r1.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(first)

      // Lockfile changes (e.g. transitive resolution bump). No project file
      // changed; cache must still bust because workspaceFingerprint differs.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(
        path.join(fixture.root, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nimporters:\n  '.': {}\n# bumped\n",
      )

      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
                exec: {
                  command: ${JSON.stringify(STAMP_CMD)},
                  env: { passThrough: ['ONE'] },
                },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })

      // Edit only the config file. It's outside `src/**` so file inputs are
      // unchanged. taskConfigHash differs -> cache must bust.
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        `
          export default {
            tasks: {
              run: {
                exec: {
                  command: ${JSON.stringify(STAMP_CMD)},
                  env: { passThrough: ['ONE', 'TWO'] },
                },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      )

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
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
        run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) }),
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
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })

      await new Promise((r) => setTimeout(r, 10))
      // Rewrite identical content so mtime advances but content hash is the same.
      await writeFile(path.join(dir, 'src/x.txt'), 'same')

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'self-bucket: changing a same-project upstream task busts the dependent',
    async () => {
      const dir = await addProject(fixture.root, 'self-up', {
        files: { 'src/codegen-input.txt': 'v1', 'src/build-input.txt': 'app' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: "cat src/codegen-input.txt > generated.txt" },
                cache: {
                  inputs: { files: ['src/codegen-input.txt'] },
                  outputs: { files: ['generated.txt'] },
                },
              },
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['codegen'],
                cache: {
                  inputs: { files: ['src/build-input.txt'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      const out1 = await readFile(path.join(dir, 'out.txt'), 'utf8')

      // Change codegen's input -> codegen reruns -> codegen hash changes ->
      // build's hash changes (default `cache.inputs.tasks` = all upstream)
      // -> build reruns even though build's own inputs are unchanged.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dir, 'src/codegen-input.txt'), 'v2')

      const r = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r.outcomes.find((o) => o.node.id === 'self-up#codegen')?.status).toBe('success')
      expect(r.outcomes.find((o) => o.node.id === 'self-up#build')?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(out1)
    },
    TIMEOUT,
  )

  it(
    'cache.inputs.files: [] is a stable empty input set (project files do not bust the cache)',
    async () => {
      const dir = await addProject(fixture.root, 'no-files', {
        files: { 'src/x.txt': 'v1', 'random.md': 'a' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: "echo a > out.txt" },
                cache: { inputs: { files: [] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })

      // Editing arbitrary project files does NOT bust because file inputs are empty.
      await writeFile(path.join(dir, 'src/x.txt'), 'v2')
      await writeFile(path.join(dir, 'random.md'), 'b')
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'cache hit overwrites local modifications to declared output files',
    async () => {
      const dir = await addProject(fixture.root, 'overwrite', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: "echo from-task > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })

      // Manually corrupt the declared output BEFORE the cached re-run.
      await writeFile(path.join(dir, 'out.txt'), 'tampered-locally')

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('from-task\n')
    },
    TIMEOUT,
  )

  it(
    'cache-hit restore removes stale files matching the output globs',
    async () => {
      const dir = await addProject(fixture.root, 'stale-restore', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: "mkdir -p dist && echo a > dist/a.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })

      // Drop a "stragler" inside the declared output dir — something a
      // prior build (or the user) left behind that the cache snapshot
      // doesn't know about.
      await writeFile(path.join(dir, 'dist/stale.txt'), 'left-over')

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'dist/a.txt'), 'utf8')).toBe('a\n')
      expect(existsSync(path.join(dir, 'dist/stale.txt'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'cache-miss exec also cleans declared outputs before running',
    async () => {
      const dir = await addProject(fixture.root, 'stale-miss', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: "mkdir -p dist && echo a > dist/a.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })

      // Pre-seed a stale file under the declared outputs BEFORE the
      // very first run. With cleanOutputs in place this gets wiped
      // before exec; without it the file would survive the run.
      await mkdir(path.join(dir, 'dist'), { recursive: true })
      await writeFile(path.join(dir, 'dist/stale.txt'), 'left-over')

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'dist/a.txt'), 'utf8')).toBe('a\n')
      expect(existsSync(path.join(dir, 'dist/stale.txt'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'does not clean output paths when cache is disabled (--no-cache)',
    async () => {
      const dir = await addProject(fixture.root, 'no-cache-no-clean', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: "mkdir -p dist && echo a > dist/a.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })

      await mkdir(path.join(dir, 'dist'), { recursive: true })
      await writeFile(path.join(dir, 'dist/manual.txt'), 'kept')

      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        noCache: true,
        log: silentLogger(fixture),
      })
      expect(r.outcomes[0]?.status).toBe('success')
      // --no-cache means "don't manage outputs either" — the user is
      // debugging, leave their files alone.
      expect(existsSync(path.join(dir, 'dist/manual.txt'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'gitignore: a negated entry (!keep.gen.ts) is included back in inputs',
    async () => {
      const dir = await addProject(fixture.root, 'gi-neg', {
        files: {
          '.gitignore': '*.gen.ts\n!keep.gen.ts\n',
          'src/x.txt': 'v1',
          'src/skip.gen.ts': 'gen-a',
          'src/keep.gen.ts': 'kept-a',
        },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const out1 = await readFile(path.join(dir, 'out.txt'), 'utf8')

      // skip.gen.ts is gitignored (matches *.gen.ts) -> editing should NOT bust.
      await writeFile(path.join(dir, 'src/skip.gen.ts'), 'gen-b')
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(out1)

      // keep.gen.ts is re-included by negated rule -> editing SHOULD bust.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dir, 'src/keep.gen.ts'), 'kept-b')
      const r3 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r3.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(out1)
    },
    TIMEOUT,
  )

  it(
    'workspace fingerprint: pnpm-workspace.yaml change busts every cached task',
    async () => {
      await addProject(fixture.root, 'wsy', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const out1 = await readFile(path.join(fixture.root, 'packages/wsy/out.txt'), 'utf8')

      // Append a comment to pnpm-workspace.yaml. Workspace fingerprint shifts;
      // every task's cache must invalidate.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(
        path.join(fixture.root, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n# bumped\n',
      )

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(fixture.root, 'packages/wsy/out.txt'), 'utf8')).not.toBe(out1)
    },
    TIMEOUT,
  )

  it(
    'sibling-package input isolation: editing one package does not bust an unrelated sibling',
    async () => {
      const dirA = await addProject(fixture.root, 'sib-a', {
        files: { 'src/a.txt': 'a-v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const dirB = await addProject(fixture.root, 'sib-b', {
        files: { 'src/b.txt': 'b-v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const aOut1 = await readFile(path.join(dirA, 'out.txt'), 'utf8')
      const bOut1 = await readFile(path.join(dirB, 'out.txt'), 'utf8')

      // Edit only sib-a's source. sib-b must NOT bust — boundaries enforce
      // that sib-a's files are not in sib-b's input set.
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(dirA, 'src/a.txt'), 'a-v2')

      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const aOutcome = r.outcomes.find((o) => o.node.id === 'sib-a#run')
      const bOutcome = r.outcomes.find((o) => o.node.id === 'sib-b#run')
      expect(aOutcome?.status).toBe('success')
      expect(bOutcome?.status).toBe('cache-hit')
      expect(await readFile(path.join(dirA, 'out.txt'), 'utf8')).not.toBe(aOut1)
      expect(await readFile(path.join(dirB, 'out.txt'), 'utf8')).toBe(bOut1)
    },
    TIMEOUT,
  )

  it(
    "honours vx.workspace.mjs's cacheDir override",
    async () => {
      await writeFile(
        path.join(fixture.root, 'vx.workspace.mjs'),
        "export default { cacheDir: 'build/.vx-cache' }",
      )
      await addProject(fixture.root, 'app-x', {
        files: { 'src/index.txt': 'hello' },
        config: `
          export default {
            tasks: {
              stamp: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['stamp'], log: silentLogger(fixture) })
      expect(existsSync(path.join(fixture.root, 'build/.vx-cache/cache.db'))).toBe(true)
      expect(existsSync(path.join(fixture.root, '.vx/cache'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'runs a group task as a no-op aggregator over dependsOn',
    async () => {
      await addProject(fixture.root, 'app-core', {
        files: { 'src/x.txt': 'core' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app-shell', {
        deps: { 'app-core': 'workspace:*' },
        config: `
          export default {
            tasks: {
              install: { dependsOn: ['^build'] },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['install'],
        projects: ['app-shell'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      const installOutcome = r.outcomes.find((o) => o.node.id === 'app-shell#install')
      const buildOutcome = r.outcomes.find((o) => o.node.id === 'app-core#build')
      expect(installOutcome?.status).toBe('success')
      expect(installOutcome?.durationMs).toBe(0)
      expect(buildOutcome?.status).toBe('success')

      const r2 = await run({
        cwd: fixture.root,
        tasks: ['install'],
        projects: ['app-shell'],
        log: silentLogger(fixture),
      })
      expect(r2.outcomes.find((o) => o.node.id === 'app-core#build')?.status).toBe('cache-hit')
      expect(r2.outcomes.find((o) => o.node.id === 'app-shell#install')?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'group tasks do NOT inflate the end-of-run summary totals',
    async () => {
      await addProject(fixture.root, 'app-z', {
        files: { 'src/y.txt': 'y' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
              ci: { dependsOn: ['build'] },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['ci'], log: silentLogger(fixture) })
      const summary = fixture.log.filter((l) => l.startsWith(' Tasks:') || l.startsWith('Cached:'))
      // Only the executable `build` task counts — the `ci` group is hidden.
      expect(summary[0]).toBe(' Tasks:    1 successful, 1 total')
      expect(summary[1]).toBe('Cached:    0 cached, 1 total')
    },
    TIMEOUT,
  )

  it(
    'group tasks do NOT appear in the runs analytics table',
    async () => {
      await addProject(fixture.root, 'core-x', {
        files: { 'src/y.txt': 'y' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
              ci: { dependsOn: ['build'] },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['ci'], log: silentLogger(fixture) })

      const { Database } = await import('bun:sqlite')
      const db = new Database(path.join(fixture.root, '.vx/cache/cache.db'), {
        readonly: true,
      })
      try {
        const rows = db.prepare('SELECT project, task FROM runs ORDER BY task').all() as Array<{
          project: string
          task: string
        }>
        expect(rows.map((r) => `${r.project}:${r.task}`)).toEqual(['core-x:build'])
      } finally {
        db.close()
      }
    },
    TIMEOUT,
  )

  it(
    'streams failed task stderr live and surfaces it on the outcome',
    async () => {
      await addProject(fixture.root, 'app-fail', {
        config: `
          export default {
            tasks: {
              broken: {
                exec: { command: 'echo MY-ERROR-MARKER >&2 && exit 42' },
              },
            },
          }
        `,
      })

      const r = await run({ cwd: fixture.root, tasks: ['broken'], log: silentLogger(fixture) })
      expect(r.ok).toBe(false)
      const o = r.outcomes.find((o) => o.node.id === 'app-fail#broken')
      expect(o?.status).toBe('failed')
      expect(o?.exitCode).toBe(42)
      // stderr is delivered via the live stream (taskStderr callback).
      expect(fixture.err.some((line) => line.includes('MY-ERROR-MARKER'))).toBe(true)

      // Live stream goes through taskStderr → fixture.err.
      const streamed = fixture.err.some((line) => line.includes('MY-ERROR-MARKER'))
      expect(streamed).toBe(true)

      // No sibling logs/ dir under cacheDir — failed-task stdout/stderr is
      // surfaced on the outcome and via the live stream; we don't duplicate
      // it to disk (CI captures stdout natively; the runs table captures
      // structured metadata).
      expect(existsSync(path.join(fixture.root, '.vx/cache/logs'))).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'thrown errors from executeTask surface via the live stream',
    async () => {
      // Force a thrown error: a command that resolves to a nonexistent
      // executable. The spawn fails with ENOENT, which surfaces via
      // Bun.spawn's error path and gets caught by the scheduler.
      await addProject(fixture.root, 'broken-spawn', {
        config: `
          export default {
            tasks: {
              run: { exec: { command: '/this/binary/does/not/exist' } },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r.ok).toBe(false)
      const o = r.outcomes.find((o) => o.node.id === 'broken-spawn#run')
      expect(o?.status).toBe('failed')
      // Start + finish status lines name the task id — that's the
      // user-visible surface a thrown error must reach.
      const statusLines = fixture.log.filter((l) => l.includes('broken-spawn#run'))
      expect(statusLines.length).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  it(
    "project's package.json change busts the cache, even with narrow inputs",
    async () => {
      // Reproduces the gap user flagged: cache.inputs.files: ['src/**']
      // doesn't include package.json, so before v12 a deps bump
      // wouldn't invalidate. Now folded in implicitly via
      // projectPackageJsonHash.
      const dir = await addProject(fixture.root, 'narrow-pkg', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      const first = await readFile(path.join(dir, 'out.txt'), 'utf8')

      // Re-run with no changes — cache hit, same out.txt.
      const r2 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')

      // Bump package.json — cache MUST bust now.
      await new Promise((r) => setTimeout(r, 5))
      const pkgPath = path.join(dir, 'package.json')
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>
      }
      pkg.dependencies = { 'fake-dep': '^1.2.3' }
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2))

      const r3 = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(r3.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).not.toBe(first)
    },
    TIMEOUT,
  )

  // forwardArgs (`--`) semantics — scoping is the subtle part.
  // The values are folded into the user-requested task's cache key
  // but NOT into dependsOn-pulled upstream keys. So `vx run app --
  // --watch` doesn't partition upstream caches across CLI flags.
  it(
    'forwardArgs change the user-requested task cache key (different args -> miss)',
    async () => {
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              say: {
                // /usr/bin/true ignores extra args. Output is the empty
                // file we write before running, so cache.save has something
                // to capture.
                exec: { command: 'true' },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      // First run with one set of forwardArgs.
      await run({
        cwd: fixture.root,
        tasks: ['say'],
        forwardArgs: ['--alpha'],
        log: silentLogger(fixture),
      })
      // Identical args -> cache hit.
      const r2 = await run({
        cwd: fixture.root,
        tasks: ['say'],
        forwardArgs: ['--alpha'],
        log: silentLogger(fixture),
      })
      expect(r2.outcomes[0]?.status).toBe('cache-hit')
      // Different args -> miss (separate entry).
      const r3 = await run({
        cwd: fixture.root,
        tasks: ['say'],
        forwardArgs: ['--beta'],
        log: silentLogger(fixture),
      })
      expect(r3.outcomes[0]?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'forwardArgs do NOT pollute upstream cache keys (dep stays cached across user-args changes)',
    async () => {
      // Two-project graph: app dependsOn lib. lib#build has no
      // user-requested args; its cache key must NOT depend on the
      // forwardArgs the user passed for `vx run app#build -- ...`.
      await addProject(fixture.root, 'lib', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'true' },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app', {
        deps: { lib: '*' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'true' },
                dependsOn: ['^build'],
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })

      // First invocation with --alpha; second with --beta. lib must
      // cache-hit on the second despite the different forwardArgs.
      await run({
        cwd: fixture.root,
        tasks: ['app#build'],
        forwardArgs: ['--alpha'],
        log: silentLogger(fixture),
      })
      const r2 = await run({
        cwd: fixture.root,
        tasks: ['app#build'],
        forwardArgs: ['--beta'],
        log: silentLogger(fixture),
      })
      expect(r2.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('cache-hit')
      // app's key DID change (its hash partitioned by forwardArgs) so
      // its own cache should miss.
      expect(r2.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'multiple positional tasks share a graph: vx run a b runs both in one invocation',
    async () => {
      await addProject(fixture.root, 'p1', {
        config: `
          export default {
            tasks: {
              a: { exec: { command: "echo a" } },
              b: { exec: { command: "echo b" } },
            },
          }
        `,
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['a', 'b'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['p1#a', 'p1#b'])
    },
    TIMEOUT,
  )

  it(
    'mixed bare + anchored positionals run a single shared graph',
    async () => {
      // `vx run app#build lint` should: run app#build directly, AND
      // fan `lint` across every project that declares it. Verify both
      // appear in outcomes with the right anchoring.
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: {
              build: { exec: { command: "echo app-build" } },
              lint:  { exec: { command: "echo app-lint" } },
            },
          }
        `,
      })
      await addProject(fixture.root, 'lib', {
        config: `
          export default {
            tasks: {
              lint: { exec: { command: "echo lib-lint" } },
            },
          }
        `,
      })

      const r = await run({
        cwd: fixture.root,
        tasks: ['app#build', 'lint'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      // app#build runs directly (anchored).
      const ids = r.outcomes.map((o) => o.node.id).sort()
      expect(ids).toContain('app#build')
      // lint fans out across every project that declares it
      // (--all-equivalent for a programmatic call with projects = undefined).
      expect(ids).toContain('app#lint')
      expect(ids).toContain('lib#lint')
    },
    TIMEOUT,
  )

  it(
    'two parallel vx run invocations against the same workspace both complete (SQLITE_BUSY busy_timeout)',
    async () => {
      // Both invocations open their own Cache handle against the same
      // cacheDir; without PRAGMA busy_timeout, one would crash with
      // SQLITE_BUSY when the other holds the writer lock. Real users
      // hit this on CI: `vx run lint & vx run test &`.
      await addProject(fixture.root, 'p', {
        config: `
          export default {
            tasks: {
              a: {
                exec: { command: 'true' },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
              b: {
                exec: { command: 'true' },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      const f1 = await makeWorkspace().then((f) => ({
        ...f,
        log: fixture.log,
        err: fixture.err,
      }))
      void f1 // reuse the shared fixture for both runs (same root)
      const [r1, r2] = await Promise.all([
        run({ cwd: fixture.root, tasks: ['a'], log: silentLogger(fixture) }),
        run({ cwd: fixture.root, tasks: ['b'], log: silentLogger(fixture) }),
      ])
      expect(r1.ok).toBe(true)
      expect(r2.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'planRun prediction matches the actual run outcome for hit / miss / group',
    async () => {
      // Property: for the same workspace + cache state, what planRun
      // predicts must match what run produces. Catches drift between
      // `computeTaskHash` and the executor.
      const { planRun } = await import('../src/orchestrator/index.js')
      await addProject(fixture.root, 'p', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
              ci: {
                dependsOn: ['build'],
              },
              dev: {
                exec: { command: 'echo dev' },
              },
            },
          }
        `,
      })
      // Cold cache: build should be a miss; dev no-cache; ci group.
      const cold = await planRun({ cwd: fixture.root, tasks: ['ci', 'dev'] })
      const coldByName = Object.fromEntries(cold.tasks.map((t) => [t.node.id, t.cacheStatus]))
      expect(coldByName['p#build']).toBe('miss')
      expect(coldByName['p#ci']).toBe('group')
      expect(coldByName['p#dev']).toBe('no-cache')

      // Real run populates the cache for build.
      await run({ cwd: fixture.root, tasks: ['ci', 'dev'], log: silentLogger(fixture) })

      // Warm cache: build now predicts hit-local.
      const warm = await planRun({ cwd: fixture.root, tasks: ['ci', 'dev'] })
      const warmByName = Object.fromEntries(warm.tasks.map((t) => [t.node.id, t.cacheStatus]))
      expect(warmByName['p#build']).toBe('hit-local')
      expect(warmByName['p#ci']).toBe('group')
      expect(warmByName['p#dev']).toBe('no-cache')
    },
    TIMEOUT,
  )
})
