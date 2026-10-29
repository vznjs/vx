// Orchestrator end to end, second half: what a run does with its outcomes —
// restores and output cleaning, groups, live streams, forwarded args,
// multi-task graphs, concurrent invocations, the plan and the records. The
// fixture lives in helpers/orchestrator-fixture.ts; the first half is
// orchestrator.test.ts.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  NO_CACHE,
  silentLogger,
  STAMP_CMD,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { run as coreRun } from '../src/orchestrator/index.js'
import { type Logger } from '../src/report/index.js'
import { lock, run } from './helpers/orchestrator.js'
import { summarized, vx } from './helpers/parity.js'

const REAL_BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

// The edges every row's projects take, whichever of them a row adds.
const EDGES = { app: ['lib'], 'app-shell': ['app-core'] }

describe('orchestrator e2e — restores, groups, streams, plan and records', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace(undefined, EDGES)
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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
    'cache hit replays stdout and stderr',
    async () => {
      await addProject(fixture.root, 'logs', {
        config: `
          export default {
            tasks: {
              run: {
                exec: {
                  command: "node -e 'process.stdout.write(\\"OUT\\\\n\\"); process.stderr.write(\\"ERR\\\\n\\")'",
                },
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
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
      // The stored output log replays both streams.
      expect(fixture.log.join('\n')).toContain('OUT')
      expect(fixture.err.join('\n')).toContain('ERR')
    },
    TIMEOUT,
  )

  it(
    'a cacheable task stores its FULL stdout and replays it byte-identically',
    async () => {
      // `cache.save` is the only consumer of `RunResult.stdout`, so the
      // executed run retains it while a non-cacheable one does not. This is
      // the one thing that gate can break: it must still be the WHOLE
      // stream, not a prefix, and it must survive the round trip unchanged.
      // Deliberately larger than one pipe chunk, so a partially-retained
      // stream would show up here rather than in a one-line fixture.
      const lines = 20_000
      await addProject(fixture.root, 'chatty', {
        config: `
          export default {
            tasks: {
              run: {
                exec: {
                  command: "node -e 'for (let i = 0; i < ${lines}; i++) process.stdout.write(\\"line-\\" + i + \\"\\\\n\\")'",
                },
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
              },
            },
          }
        `,
      })
      const captured: string[] = []
      const capture = (): Logger => {
        let buf = ''
        return {
          status() {},
          taskStdout(_node, chunk) {
            buf += chunk
          },
          taskStderr() {},
          taskComplete() {
            captured.push(buf)
            buf = ''
          },
        }
      }

      const miss = await run({ cwd: fixture.root, tasks: ['run'], log: capture() })
      expect(miss.outcomes[0]?.status).toBe('success')
      const hit = await run({ cwd: fixture.root, tasks: ['run'], log: capture() })
      expect(hit.outcomes[0]?.status).toBe('cache-hit')

      const [executed, replayed] = captured
      // Whole stream, not a prefix: first line, last line, exact length.
      expect(executed).toContain('line-0\n')
      expect(executed).toContain(`line-${lines - 1}\n`)
      expect(executed!.split('\n').filter((l) => l.length > 0)).toHaveLength(lines)
      // …and the replay is the same bytes, not merely similar.
      expect(replayed).toBe(executed)
    },
    TIMEOUT,
  )

  it(
    'upstream env change invalidates the dependent (pure-input transitive; no cutoff)',
    async () => {
      await addProject(fixture.root, 'lib', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "cat src/x.txt > dist.txt" },
                inputs: { files: ['**/*'], env: ['API_URL'] },
                cache: {
                  outputs: { files: ['dist.txt'] },
                },
              },
            },
          }
        `,
      })
      const appDir = await addProject(fixture.root, 'app', {
        files: { 'src/y.txt': 'app' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['^build'],
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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

      // Change API_URL: lib's env input changes -> lib's key changes ->
      // lib reruns. Even though its output bytes are unchanged, app
      // folds lib's INPUT key (no early cutoff), so app RE-RUNS too.
      process.env.API_URL = 'https://b.example'
      const r3 = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(r3.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('success')
      expect(r3.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('success')
      // app re-stamped a fresh out.txt.
      expect(await readFile(path.join(appDir, 'out.txt'), 'utf8')).not.toBe(appOut1)

      delete process.env.API_URL
    },
    TIMEOUT,
  )

  it(
    'a TRACKING-ONLY env input: the key moves on a value the command cannot read',
    async () => {
      // The direction the suite was missing. `orchestrator.test.ts` §
      // "inputs.env affects the cache key; exec.env.passThrough alone
      // does not" pins the common pairing, with both names ALSO passed
      // through; Turbo parity pins the same asymmetry against turbo.json.
      // Neither covers the shape schema.md calls "legal but rare": a name in
      // `inputs.env` and NOT in `exec.env.passThrough`, where the child
      // environment is isolated so "the key varies on a value the command
      // never sees" — a miss that re-runs and reproduces identical bytes.
      const dir = await addProject(fixture.root, 'envtrack', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'printf "%s" "[$VX_T_TRACKED]" > out.txt' },
                inputs: { files: ['src/**'], env: ['VX_T_TRACKED'] },
                cache: {
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      const build = async (): Promise<string> => {
        const r = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        expect(r.ok).toBe(true)
        return r.outcomes[0]!.status
      }

      try {
        process.env['VX_T_TRACKED'] = 'one'
        expect(await build()).toBe('success')
        // Isolated: declaring it as a cache input forwards NOTHING.
        expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('[]')
        expect(await build()).toBe('cache-hit')

        process.env['VX_T_TRACKED'] = 'two'
        // The key folded the value, so it misses…
        expect(await build()).toBe('success')
        // …and the re-run writes exactly what it wrote before, which is the
        // cost of declaring one axis and not the other.
        expect(await readFile(path.join(dir, 'out.txt'), 'utf8')).toBe('[]')
      } finally {
        delete process.env['VX_T_TRACKED']
      }
    },
    TIMEOUT,
  )

  it(
    'no plugin: a root lockfile, .npmrc or package.json edit moves no key',
    async () => {
      // Core keys no package file (language-agnostic core, PR 4): without a
      // lockfile plugin, none of these reaches a key — the price of the
      // decision, which `@vzn/vx-lockfile` pays back.
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const status = async (): Promise<string | undefined> =>
        (await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })).outcomes[0]
          ?.status
      expect(await status()).toBe('success')
      expect(await status()).toBe('cache-hit')

      await writeFile(
        path.join(fixture.root, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\nimporters:\n  '.': {}\n# bumped\n",
      )
      expect(await status()).toBe('cache-hit')
      await writeFile(path.join(fixture.root, '.npmrc'), 'node-linker=hoisted\n')
      expect(await status()).toBe('cache-hit')
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'lockproj', version: '0.0.1' }),
      )
      expect(await status()).toBe('cache-hit')
      // CONTROL: a declared input still moves it.
      await writeFile(path.join(dir, 'src', 'x.txt'), 'v2')
      expect(await status()).toBe('success')
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
                inputs: { files: ['src/**'] },
                cache: {
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
                inputs: { files: ['src/**'] },
                cache: {
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
    'two configs naming one project error clearly, naming both directories',
    async () => {
      for (const dir of ['packages/a', 'packages/b']) {
        await mkdir(path.join(fixture.root, dir), { recursive: true })
        await writeFile(
          path.join(fixture.root, dir, 'vx.config.mjs'),
          "export default { name: 'dup', tasks: {} }\n",
        )
      }

      await expect(
        run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) }),
      ).rejects.toThrow(
        new Error(
          '✗ vx lock  lock not written\n\n  two projects are named "dup": packages/a and packages/b — give one another `name` in its vx.config',
        ),
      )
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/codegen-input.txt'] },
                cache: {
                  outputs: { files: ['generated.txt'] },
                },
              },
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                dependsOn: ['codegen'],
                inputs: { files: ['src/build-input.txt'] },
                cache: {
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
      // build's hash changes (default `inputs.tasks` = all upstream)
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
    'inputs.files: [] is a stable empty input set (project files do not bust the cache)',
    async () => {
      const dir = await addProject(fixture.root, 'no-files', {
        files: { 'src/x.txt': 'v1', 'random.md': 'a' },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: "echo a > out.txt" },
                inputs: { files: [] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
        cache: NO_CACHE,
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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

  // nx#19796: a directory re-included under an ignored one (`gen/*` then
  // `!gen/keep/`) was left out of the inputs.
  it(
    'gitignore: a directory re-included under an ignored parent is an input, its ignored siblings are not',
    async () => {
      const dir = await addProject(fixture.root, 'gi-dir', {
        files: {
          '.gitignore': 'gen/*\n!gen/keep/\n',
          'src/x.txt': 'v1',
          'gen/keep/k.txt': 'k1',
          'gen/other.txt': 'o1',
        },
        config: `
          export default {
            tasks: {
              run: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const status = async () =>
        (await run({ cwd: fixture.root, tasks: ['run'], log: silentLogger(fixture) })).outcomes[0]
          ?.status
      expect(await status()).toBe('success')
      await writeFile(path.join(dir, 'gen/keep/k.txt'), 'k2')
      expect(await status()).toBe('success')
      await writeFile(path.join(dir, 'gen/other.txt'), 'o2')
      expect(await status()).toBe('cache-hit')
    },
    TIMEOUT,
  )

  // turborepo#7245: a deleted package stayed in the graph after a warm run.
  it(
    'a project deleted after a warm run and a lock is named by the next run until a re-lock',
    async () => {
      const build = `
          export default {
            tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } },
          }
        `
      await addProject(fixture.root, 'keep', { config: build, files: { 'src/a.txt': 'a' } })
      await addProject(fixture.root, 'gone', { config: build, files: { 'src/a.txt': 'a' } })
      expect((await vx(fixture.root, ['run', 'build', '--all'])).code).toBe(0)
      await rm(path.join(fixture.root, 'packages', 'gone'), { recursive: true })

      // The lock still holds `gone`: a run takes its projects from the lock.
      const stale = Bun.spawnSync(
        [process.execPath, REAL_BIN, 'run', 'build', '--all', '--dry=json'],
        { cwd: fixture.root, stderr: 'pipe' },
      )
      expect([stale.exitCode, stale.stderr.toString()]).toEqual([
        1,
        '✗ vx run  .vx/projects.lock.json locks packages/gone, but its vx.config.mjs is gone — run `vx lock`\n',
      ])
      const again = await summarized(fixture.root, ['build', '--all'])
      expect({ code: again.code, ids: [...again.tasks.keys()] }).toEqual({
        code: 0,
        ids: ['keep#build'],
      })
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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
    "honours .vx/workspace.mjs's cache.dir, which VX_CACHE_DIR would beat",
    async () => {
      const env = process.env['VX_CACHE_DIR']
      delete process.env['VX_CACHE_DIR']
      await Bun.write(
        path.join(fixture.root, '.vx/workspace.mjs'),
        `export default { cache: { dir: 'build/.vx-cache' }, plugins: [] }\n`,
      )
      await addProject(fixture.root, 'app-x', {
        files: { 'src/index.txt': 'hello' },
        config: `
          export default {
            tasks: {
              stamp: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      try {
        await run({ cwd: fixture.root, tasks: ['stamp'], log: silentLogger(fixture) })
      } finally {
        if (env !== undefined) process.env['VX_CACHE_DIR'] = env
      }
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app-shell', {
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
              },
              ci: { dependsOn: ['build'] },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['ci'], log: silentLogger(fixture) })
      // Meter legends only — the footer's projects legend shares the
      // 12-space indent but carries projects, not task/cache counts.
      const legends = fixture.log.filter((l) => /^ {12}\S/.test(l) && !l.includes(' affected · '))
      // Only the executable `build` task counts — the `ci` group is hidden.
      expect(legends[0]).toBe('            1 success · 1 total')
      expect(legends[1]).toBe('            local 1↑')
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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
        const rows = db.query('SELECT project, task FROM runs ORDER BY task').all() as Array<{
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
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

  // turborepo#1744: arguments after `--` reached every task in the graph,
  // so a dependency's build ran with the app's flags.
  it(
    'arguments after -- reach the named task command and never its dependency',
    async () => {
      const argsTask = (deps: string) => `
          export default {
            tasks: {
              build: { exec: { command: 'echo ARGS: > args.txt' }, dependsOn: [${deps}] },
            },
          }
        `
      const lib = await addProject(fixture.root, 'lib', { config: argsTask('') })
      const app = await addProject(fixture.root, 'app', {
        config: argsTask(`'^build'`),
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['app#build'],
        forwardArgs: ['--mode', 'dev'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(await readFile(path.join(lib, 'args.txt'), 'utf8')).toBe('ARGS:\n')
      expect(await readFile(path.join(app, 'args.txt'), 'utf8')).toBe('ARGS: --mode dev\n')
    },
    TIMEOUT,
  )

  // Other runners gave the args to the first project only, or to one
  // command line of several, or ran a requested task twice when another
  // requested task also depended on it.
  it(
    'arguments after -- reach every requested task, once each, and no dependency',
    async () => {
      const task = (deps: string) => `
          export default {
            tasks: {
              build: { exec: { command: 'echo ran >> runs.txt\\necho ARGS: > args.txt' }, dependsOn: [${deps}] },
            },
          }
        `
      const c = await addProject(fixture.root, 'c', { config: task('') })
      const b = await addProject(fixture.root, 'b', { config: task(`'c#build'`) })
      const a = await addProject(fixture.root, 'a', { config: task(`'b#build'`) })
      const r = await run({
        cwd: fixture.root,
        tasks: ['a#build', 'c#build'],
        forwardArgs: ['0', '--x', 'two words'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      const read = (dir: string, f: string) => readFile(path.join(dir, f), 'utf8')
      expect(await read(a, 'args.txt')).toBe('ARGS: 0 --x two words\n')
      expect(await read(b, 'args.txt')).toBe('ARGS:\n')
      expect(await read(c, 'args.txt')).toBe('ARGS: 0 --x two words\n')
      expect(await Promise.all([a, b, c].map((d) => read(d, 'runs.txt')))).toEqual([
        'ran\n',
        'ran\n',
        'ran\n',
      ])
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
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
              },
              b: {
                exec: { command: 'true' },
                inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
              },
            },
          }
        `,
      })
      // Both runs share the one fixture, so the one cache dir, and the one lock.
      await lock(fixture.root)
      const [r1, r2] = await Promise.all([
        coreRun({ cwd: fixture.root, tasks: ['a'], log: silentLogger(fixture) }),
        coreRun({ cwd: fixture.root, tasks: ['b'], log: silentLogger(fixture) }),
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
      const { planRun } = await import('./helpers/orchestrator.js')
      await addProject(fixture.root, 'p', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
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

  it(
    'planRun attaches per-task p50 history + a critical-path time prediction',
    async () => {
      const { planRun } = await import('../src/orchestrator/index.js')
      const dir = await addProject(fixture.root, 'eta', {
        files: { 'src/x.txt': 'v1' },
        config: `
          export default {
            tasks: {
              slow: {
                exec: { command: 'sleep 0.12 && echo s > slow.txt' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['slow.txt'] } },
              },
              dep: {
                dependsOn: ['slow'],
                exec: { command: 'sleep 0.04 && echo d > dep.txt' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dep.txt'] } },
              },
              solo: {
                exec: { command: 'echo q > solo.txt' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['solo.txt'] } },
              },
            },
          }
        `,
      })
      // One real run records history (durations land in the local runs table).
      const r = await run({ cwd: fixture.root, tasks: ['dep', 'solo'], log: silentLogger(fixture) })
      expect(r.ok).toBe(true)
      // Change the shared input so every task predicts MISS again.
      await Bun.write(path.join(dir, 'src', 'x.txt'), 'v2')
      const p = await planRun({ cwd: fixture.root, tasks: ['dep', 'solo'] })
      const byId = new Map(p.tasks.map((t) => [t.node.id, t]))
      const slow = byId.get('eta#slow')!
      const dep = byId.get('eta#dep')!
      const solo = byId.get('eta#solo')!
      expect(slow.cacheStatus).toBe('miss')
      expect(slow.p50Ms).toBeGreaterThan(0)
      expect(dep.p50Ms).toBeGreaterThan(0)
      // A sub-millisecond echo legitimately records 0ms on a fast runner —
      // defined is the pin; the sums below still hold with a 0 term.
      expect(solo.p50Ms).toBeDefined()
      // Relational pins only (recorded durations vary with load): the
      // slow → dep chain is the wall-clock floor, the totals are exact sums.
      expect(p.predicted).toBeDefined()
      expect(p.predicted!.wallMs).toBe(slow.p50Ms! + dep.p50Ms!)
      expect(p.predicted!.workMs).toBe(slow.p50Ms! + dep.p50Ms! + solo.p50Ms!)
      expect(p.predicted!.unknownCount).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'records a Tier-3 invocation row + per-entry input rows on save; warm hit writes none',
    async () => {
      await addProject(fixture.root, 'app-rec', {
        files: { 'src/x.txt': 'hello' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(STAMP_CMD)} },
                inputs: { files: ['**/*'] }, cache: { outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const { Database } = await import('bun:sqlite')
      const dbPath = path.join(fixture.root, '.vx', 'cache', 'cache.db')

      // First run: miss. Tagged + a custom command + broad flow.
      const first = await run({
        cwd: fixture.root,
        tasks: ['build'],
        flow: 'broad',
        command: 'vx run build --all',
        branch: 'feature/named',
        log: silentLogger(fixture),
      })
      expect(first.outcomes[0]?.status).toBe('success')

      let totalAfterMiss = 0
      {
        const db = new Database(dbPath, { readonly: true })
        const invs = db.query('SELECT * FROM invocations').all() as Array<Record<string, unknown>>
        expect(invs).toHaveLength(1)
        const inv = invs[0]!
        expect(inv.command).toBe('vx run build --all')
        expect(inv.requested_tasks).toBe(JSON.stringify(['build']))
        expect(inv.flow).toBe('broad')
        expect(inv.task_count).toBe(1)
        expect(inv.failed_count).toBe(0)
        expect(inv.exit_ok).toBe(1)
        expect(inv.vx_version).toBeTruthy()
        // `--branch` names the branch the history records, over git's.
        expect(inv.branch).toBe('feature/named')

        // The miss saved an entry with its input fingerprint rows. They're
        // keyed by the entry hash — reachable via runs.hash for this task.
        const rows = db
          .query(
            `SELECT j.value->>0 AS kind, j.value->>1 AS name FROM entry_inputs ei
             JOIN runs r ON r.hash = ei.entry_hash, json_each(ei.components) j
             WHERE r.project = ? AND r.task = ?`,
          )
          .all('app-rec', 'build') as Array<{ kind: string; name: string }>
        const kinds = new Set(rows.map((r) => r.kind))
        expect(kinds.has('config')).toBe(true)
        // Core keys no package file: no package or workspace row.
        expect(kinds.has('package')).toBe(false)
        expect(kinds.has('workspace')).toBe(false)
        expect(rows.some((r) => r.kind === 'file')).toBe(true)
        totalAfterMiss = (db.query('SELECT COUNT(*) AS n FROM entry_inputs').get() as { n: number })
          .n
        expect(totalAfterMiss).toBeGreaterThan(0)
        db.close()
      }

      // Second run: cache hit. A hit never saves, so it writes ZERO new
      // entry_inputs rows — the whole point of the persistence redesign.
      const second = await run({
        cwd: fixture.root,
        tasks: ['build'],
        log: silentLogger(fixture),
      })
      expect(second.outcomes[0]?.status).toBe('cache-hit')

      {
        const db = new Database(dbPath, { readonly: true })
        const invs = db.query('SELECT run_id FROM invocations ORDER BY started_at').all() as Array<{
          run_id: string
        }>
        expect(invs).toHaveLength(2)
        // Warm run adds no entry_inputs rows.
        const totalAfterHit = (
          db.query('SELECT COUNT(*) AS n FROM entry_inputs').get() as { n: number }
        ).n
        expect(totalAfterHit).toBe(totalAfterMiss)
        // But the hit's invocation header is still recorded.
        const hitRunId = invs[1]!.run_id
        const hitInv = db
          .query('SELECT hit_local_count, hit_count FROM invocations WHERE run_id = ?')
          .get(hitRunId) as { hit_local_count: number; hit_count: number }
        expect(hitInv.hit_local_count).toBe(1)
        expect(hitInv.hit_count).toBe(1)
        db.close()
      }
    },
    TIMEOUT,
  )
})

describe('the widest glob still stops at the project boundary', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'a task declaring `**/*` folds nothing outside its own project',
    async () => {
      // Each exclusion is pinned on its own — nested projects, ALWAYS_IGNORE,
      // sibling projects, the `..` refusal. This is the COMPOSITE, on a real
      // run with real discovery and real git: the widest glob there is, with
      // a declared workspace member nested INSIDE the project, node_modules
      // beside it and a sibling next door. A boundary that leaked would show
      // up here as a miss where the run should hit (2026-09-20).
      const a = await addProject(fixture.root, 'a', {
        files: { 'src/own.txt': 'own-1\n' },
        config: `export default { tasks: { build: {
          exec: { command: 'true' },
          inputs: { files: ['**/*'] }, cache: { outputs: { files: [] } },
        } } }`,
      })
      const b = await addProject(fixture.root, 'b', {
        files: { 'src/b.txt': 'b-1\n' },
        config: `export default { tasks: { build: {
          exec: { command: 'true' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
        } } }`,
      })
      // A workspace MEMBER nested inside a: without the second workspace
      // glob it is not a member, and a bare package.json under `a` is just
      // part of `a`. A member fences with or without a config (X-57).
      await writeFile(
        path.join(fixture.root, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n  - "packages/a/nested"\n',
      )
      const nested = path.join(a, 'nested')
      await mkdir(path.join(nested, 'src'), { recursive: true })
      await writeFile(
        path.join(nested, 'package.json'),
        JSON.stringify({ name: 'nested', version: '0.0.0' }),
      )
      await writeFile(
        path.join(nested, 'vx.config.mjs'),
        `export default { tasks: { build: {
          exec: { command: 'true' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
        } } }`,
      )
      await writeFile(path.join(nested, 'src', 'their.txt'), 'their-1\n')
      await mkdir(path.join(a, 'node_modules', 'dep'), { recursive: true })
      await writeFile(path.join(a, 'node_modules', 'dep', 'index.js'), 'dep-1\n')

      const build = async (): Promise<string> => {
        const r = await run({
          cwd: fixture.root,
          tasks: ['build'],
          projects: ['a'],
          log: silentLogger(fixture),
        })
        expect(r.ok).toBe(true)
        return r.outcomes[0]!.status
      }

      expect(await build()).toBe('success')

      // Everything a leaking boundary would fold, changed at once.
      await writeFile(path.join(nested, 'src', 'their.txt'), 'their-2\n')
      await writeFile(
        path.join(nested, 'package.json'),
        JSON.stringify({ name: 'nested', version: '0.0.1' }),
      )
      await writeFile(path.join(a, 'node_modules', 'dep', 'index.js'), 'dep-2\n')
      await writeFile(path.join(b, 'src', 'b.txt'), 'b-2\n')
      expect(await build()).toBe('cache-hit')

      // CONTROL: the project's OWN file still moves it.
      await writeFile(path.join(a, 'src', 'own.txt'), 'own-2\n')
      expect(await build()).toBe('success')
    },
    TIMEOUT,
  )
})
