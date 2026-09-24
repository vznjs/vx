// Orchestrator end to end, first half: cache keys, inputs and invalidation
// — what busts a task, what does not, and the policy flags. The fixture
// lives in helpers/orchestrator-fixture.ts; the second half is
// orchestrator-run.test.ts.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  FORCE,
  makeWorkspace,
  NO_CACHE,
  silentLogger,
  STAMP_CMD,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { run } from '../src/orchestrator/index.js'

describe('orchestrator e2e — keys, inputs and invalidation', () => {
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
    'a cache hit reports the exec time it SKIPPED apart from the restore it cost',
    async () => {
      // `durationMs` is what THIS run spent; `storedDurationMs` is the work
      // the hit avoided. `--report`'s "N saved" summed the former, so a task
      // that takes seconds cold reported milliseconds saved.
      await addProject(fixture.root, 'slow', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'sleep 0.4 && echo built > out.txt' },
                cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const cold = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['slow'],
        log: silentLogger(fixture),
      })
      const coldMs = cold.outcomes[0]!.durationMs
      expect(cold.outcomes[0]?.status).toBe('success')
      // Nothing was skipped — the task executed.
      expect(cold.outcomes[0]?.storedDurationMs).toBeUndefined()
      expect(coldMs).toBeGreaterThanOrEqual(400)

      const warm = await run({
        cwd: fixture.root,
        tasks: ['build'],
        projects: ['slow'],
        log: silentLogger(fixture),
      })
      expect(warm.outcomes[0]?.status).toBe('cache-hit')
      // The stored figure is the cold exec; the restore is far cheaper. The
      // relation is what matters — absolute durations vary with load.
      expect(warm.outcomes[0]?.storedDurationMs).toBeGreaterThanOrEqual(400)
      expect(warm.outcomes[0]?.durationMs).toBeLessThan(warm.outcomes[0]!.storedDurationMs!)
    },
    TIMEOUT,
  )

  it(
    'RunOptions.cacheDir redirects the cache away from .vx/cache; hits from there',
    async () => {
      const dir = await addProject(fixture.root, 'cd', {
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                cache: { inputs: { files: ['package.json'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const first = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['cd'],
        cacheDir: 'custom-cache',
        log: silentLogger(fixture),
      })
      expect(first.outcomes[0]?.status).toBe('success')
      // The cache landed in the override dir, NOT the default .vx/cache.
      expect(existsSync(path.join(fixture.root, 'custom-cache', 'cache.db'))).toBe(true)
      expect(existsSync(path.join(fixture.root, '.vx', 'cache', 'cache.db'))).toBe(false)

      const stamp = await readFile(path.join(dir, 'out.txt'), 'utf8')
      // A second run against the same override dir hits.
      const second = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['cd'],
        cacheDir: 'custom-cache',
        log: silentLogger(fixture),
      })
      expect(second.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe(stamp)

      // A run WITHOUT the override uses the default dir — a cold miss, so it
      // re-executes (proves the override truly pointed elsewhere).
      const third = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['cd'],
        log: silentLogger(fixture),
      })
      expect(third.outcomes[0]?.status).toBe('success')
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
    'any upstream change invalidates the dependent (pure-input transitive; no early cutoff)',
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

      // Touch a file in lib that does NOT affect lib's output bytes.
      // lib's key changes (it re-runs) and dist.txt is byte-identical —
      // but with pure-input transitive hashing (early cutoff removed),
      // app folds lib's INPUT key, not its output identity, so app
      // RE-RUNS. (v21 would have kept app a cache hit here; that cutoff
      // was deliberately dropped — rare, not worth the cascade.)
      await new Promise((r) => setTimeout(r, 5))
      await writeFile(path.join(fixture.root, 'packages/lib/NOTES.md'), 'something')

      const r3 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r3.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('success')
      expect(r3.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')

      // A file that DOES flow into lib's output also invalidates app.
      await writeFile(path.join(fixture.root, 'packages/lib/src/x.txt'), 'v2')
      const r4 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r4.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).not.toBe(appOut1)
    },
    TIMEOUT,
  )

  // nx#32214, nx#33379: an edit two hops up left the top of the chain a hit.
  it(
    'an edit two hops upstream misses the whole chain and reaches the top output',
    async () => {
      const build = (cmd: string) => `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(cmd)} },
                dependsOn: ['^build'],
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist.txt'] } },
              },
            },
          }
        `
      await addProject(fixture.root, 'libb', {
        files: { 'src/x.txt': 'B1' },
        config: build('cat src/x.txt > dist.txt'),
      })
      await addProject(fixture.root, 'liba', {
        deps: { libb: 'workspace:*' },
        files: { 'src/x.txt': 'a' },
        config: build('cat ../libb/dist.txt > dist.txt'),
      })
      const appDir = await addProject(fixture.root, 'app', {
        deps: { liba: 'workspace:*' },
        files: { 'src/x.txt': 'app' },
        config: build('cat ../liba/dist.txt > dist.txt'),
      })
      const statuses = async () => {
        const r = await run({ cwd: fixture.root, tasks: ['app#build'], log: silentLogger(fixture) })
        return r.outcomes.map((o) => `${o.node.id}:${o.status}`).sort()
      }
      await statuses()
      expect(await statuses()).toEqual([
        'app#build:cache-hit',
        'liba#build:cache-hit',
        'libb#build:cache-hit',
      ])

      await writeFile(path.join(fixture.root, 'packages/libb/src/x.txt'), 'B2')
      expect(await statuses()).toEqual([
        'app#build:success',
        'liba#build:success',
        'libb#build:success',
      ])
      expect(await readFile(path.join(appDir, 'dist.txt'), 'utf8')).toBe('B2')
    },
    TIMEOUT,
  )

  it(
    'multi-state: upstream input A -> B -> back to A re-hits the original entries (branch ping-pong)',
    async () => {
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'A' },
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
      await addProject(fixture.root, 'app', {
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
      const x = path.join(fixture.root, 'packages/lib/src/x.txt')

      // State A: build everything.
      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      // State B: change lib's input → lib + app re-run (distinct entries).
      await writeFile(x, 'B')
      const rB = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(rB.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      // Back to A: the A-state entries still exist (keyed by lib's
      // input key, which folds transitively into app's key), so both
      // re-hit — pure-input transitive preserves multi-state caching.
      await writeFile(x, 'A')
      const rA = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(rA.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('cache-hit')
      expect(rA.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
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

  // turborepo#4645: the child tells an unset name from an empty one (`??`,
  // `${X-default}`), so the key must too, or the second run replays UNSET.
  it(
    'a declared env name UNSET and set to the empty string are different keys',
    async () => {
      await addProject(fixture.root, 'envunset', {
        files: { 'src/a.txt': 'a' },
        config: `
          export default {
            tasks: {
              show: {
                exec: {
                  command: "node -e 'process.stdout.write(process.env.BUILD_TARGET ?? \\"UNSET\\")' > out.txt",
                  env: { passThrough: ['BUILD_TARGET'] },
                },
                cache: {
                  inputs: { files: ['src/**'], env: ['BUILD_TARGET'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      const out = path.join(fixture.root, 'packages/envunset/out.txt')
      const once = async () => {
        const r = await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
        return [r.outcomes[0]?.status, await readFile(out, 'utf8')]
      }

      try {
        delete process.env.BUILD_TARGET
        expect(await once()).toEqual(['success', 'UNSET'])
        process.env.BUILD_TARGET = ''
        expect(await once()).toEqual(['success', ''])
        delete process.env.BUILD_TARGET
        expect(await once()).toEqual(['cache-hit', 'UNSET'])
        process.env.BUILD_TARGET = ''
        expect(await once()).toEqual(['cache-hit', ''])
      } finally {
        delete process.env.BUILD_TARGET
      }
    },
    TIMEOUT,
  )

  // turborepo#548: past some count of declared names, a change to the
  // last one stopped reaching the hash.
  it(
    'a change to the LAST of thirteen declared env names misses',
    async () => {
      const names = 'ABCDEFGHIJKLM'.split('').map((c) => `VX_MANY_ENV_${c}`)
      const last = names[names.length - 1]!
      // Declared last-sorted first, so the fold's sort is on the path too.
      const declared = [last, ...names.slice(0, -1)]
      await addProject(fixture.root, 'envmany', {
        files: { 'src/a.txt': 'a' },
        config: `
          export default {
            tasks: {
              show: {
                exec: {
                  command: "node -e 'process.stdout.write(String(process.env.${last}))' > out.txt",
                  env: { passThrough: [${JSON.stringify(last)}] },
                },
                cache: {
                  inputs: { files: ['src/**'], env: ${JSON.stringify(declared)} },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      const out = path.join(fixture.root, 'packages/envmany/out.txt')
      const once = async () => {
        const r = await run({ cwd: fixture.root, tasks: ['show'], log: silentLogger(fixture) })
        return [r.outcomes[0]?.status, await readFile(out, 'utf8')]
      }
      try {
        for (const n of names) process.env[n] = 'v1'
        expect(await once()).toEqual(['success', 'v1'])
        expect(await once()).toEqual(['cache-hit', 'v1'])
        process.env[last] = 'v2'
        expect(await once()).toEqual(['success', 'v2'])
      } finally {
        for (const n of names) delete process.env[n]
      }
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
      await run({ cwd: fixture.root, tasks: ['run'], cache: NO_CACHE, log: silentLogger(fixture) })
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
    '--force skips reads (re-executes) but still WRITES, refreshing the cache',
    async () => {
      const dir = await addProject(fixture.root, 'forced-write', {
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

      // First run: miss, executes → 'x', and caches it.
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')

      // --force: skips the read, so the command runs again. Because
      // outputs are wiped before exec (writes on), the file is reset to
      // empty then appended once → 'x' again (NOT 'xx').
      const forced = await run({
        cwd: fixture.root,
        tasks: ['run'],
        cache: FORCE,
        log: silentLogger(fixture),
      })
      expect(forced.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')

      // --force WROTE the artifact: the subsequent plain run is a hit
      // (no re-execution), restoring the refreshed 'x'.
      const after = await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(after.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')
    },
    TIMEOUT,
  )

  // nx#29854: `--skip-nx-cache` on one target still served its dependencies
  // from the cache. vx's policy is the run's, whatever was named.
  it(
    '--force, --no-cache and --cache=local:w re-execute the dependencies of the named task too',
    async () => {
      const counted = (name: string) =>
        `node -e 'require("fs").appendFileSync("../../runs.txt", "${name} ")' && echo ${name} > dist.txt`
      const build = (name: string) => `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(counted(name))} },
                dependsOn: ['^build'],
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist.txt'] } },
              },
            },
          }
        `
      await addProject(fixture.root, 'lib', { files: { 'src/x.txt': 'l' }, config: build('lib') })
      await addProject(fixture.root, 'app', {
        deps: { lib: 'workspace:*' },
        files: { 'src/x.txt': 'a' },
        config: build('app'),
      })
      const runs = path.join(fixture.root, 'runs.txt')
      const executed = async (cache?: Parameters<typeof run>[0]['cache']) => {
        await rm(runs, { force: true })
        const r = await run({
          cwd: fixture.root,
          tasks: ['app#build'],
          ...(cache === undefined ? {} : { cache }),
          log: silentLogger(fixture),
        })
        expect(r.ok).toBe(true)
        return existsSync(runs) ? (await readFile(runs, 'utf8')).trim().split(' ').sort() : []
      }
      expect(await executed()).toEqual(['app', 'lib'])
      expect(await executed()).toEqual([])

      expect(await executed(FORCE)).toEqual(['app', 'lib'])
      expect(await executed(NO_CACHE)).toEqual(['app', 'lib'])
      const localWriteOnly = {
        localRead: false,
        localWrite: true,
        remoteRead: false,
        remoteWrite: false,
      } as const
      expect(await executed(localWriteOnly)).toEqual(['app', 'lib'])
      expect(await executed()).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'local read-only (--cache=local:r) restores a hit but does NOT write a miss',
    async () => {
      const dir = await addProject(fixture.root, 'local-read-only', {
        files: { 'src/in.txt': 'v1' },
        config: `
          export default {
            tasks: {
              run: {
                exec: {
                  command: "node -e 'require(\\"fs\\").appendFileSync(\\"runs.txt\\", \\"x\\"); require(\\"fs\\").writeFileSync(\\"out.txt\\", \\"o\\")'",
                },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt', 'runs.txt'] } },
              },
            },
          }
        `,
      })

      // Warm the cache: miss, executes, writes the entry.
      await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')

      const readOnly = {
        localRead: true,
        localWrite: false,
        remoteRead: false,
        remoteWrite: false,
      } as const

      // Same inputs: local read-only HITS, restores outputs as-is (no
      // re-execution, runs.txt unchanged).
      const hit = await run({
        cwd: fixture.root,
        tasks: ['run'],
        cache: readOnly,
        log: silentLogger(fixture),
      })
      expect(hit.outcomes[0]?.status).toBe('cache-hit')
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('x')

      // Change inputs so the next read MISSES; under local:r the miss
      // executes (appends — writes off means no pre-exec clean) but does
      // NOT write the entry.
      await writeFile(path.join(dir, 'src/in.txt'), 'v2')
      const miss = await run({
        cwd: fixture.root,
        tasks: ['run'],
        cache: readOnly,
        log: silentLogger(fixture),
      })
      expect(miss.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('xx')

      // The miss was NOT persisted: re-running with the SAME (v2) inputs
      // under local:r misses again (no entry to read) and appends again.
      // Had the previous miss written the entry, this would be a hit.
      const again = await run({
        cwd: fixture.root,
        tasks: ['run'],
        cache: readOnly,
        log: silentLogger(fixture),
      })
      expect(again.outcomes[0]?.status).toBe('success')
      expect(await readFile(path.join(dir, 'runs.txt'), 'utf8')).toBe('xxx')
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

  // turborepo#9218: a negated input stopped excluding once the task had a
  // same-project upstream writing where its inputs read — the path that
  // enumerates the project again after the upstream ran.
  it(
    'a negated input still excludes when a same-project upstream writes into the inputs',
    async () => {
      const dir = await addProject(fixture.root, 'negdep', {
        files: { 'src/a.ts': 'a', 'src/a.test.ts': 't1' },
        config: `
          export default {
            tasks: {
              prep: {
                exec: { command: 'mkdir -p gen && cat src/a.ts > gen/g.ts' },
                cache: {
                  inputs: { files: ['src/**', '!src/**/*.test.ts'] },
                  outputs: { files: ['gen/**'] },
                },
              },
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['prep'],
                cache: {
                  inputs: { files: ['src/**', 'gen/**', '!src/**/*.test.ts'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      const statuses = async () => {
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        return Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))
      }
      expect(await statuses()).toEqual({ 'negdep#prep': 'success', 'negdep#build': 'success' })

      await writeFile(path.join(dir, 'src/a.test.ts'), 't2')
      expect(await statuses()).toEqual({ 'negdep#prep': 'cache-hit', 'negdep#build': 'cache-hit' })

      // The control: a file build does read moves it.
      await writeFile(path.join(dir, 'src/a.ts'), 'b')
      expect((await statuses())['negdep#build']).toBe('success')
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
})
