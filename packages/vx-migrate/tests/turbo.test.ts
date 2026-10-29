// A Turbo repo runs under vx with no vx.config written. Every pin is a real
// `planRun` / `run` over a workspace whose only vx file declares the plugin:
// the migrate suite's Turbo fixture, minus the migration.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type Logger, type ProjectConfig, type ProjectMeta } from '@vzn/vx'
import { lock, planRun, run } from '../../vx/tests/helpers/orchestrator.js'
import { turbo } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { tamperMapping } from './helpers/tamper-mapping.js'
import { notTurbos } from './helpers/turbo-own.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const TIMEOUT = 30_000

const TURBO_JSON = {
  globalDependencies: ['tsconfig.base.json'],
  globalEnv: ['GLOBAL_MODE'],
  globalPassThroughEnv: ['AWS_PROFILE'],
  tasks: {
    build: {
      dependsOn: ['^build', 'codegen'],
      inputs: ['$TURBO_DEFAULT$', '!**/*.md', '$TURBO_ROOT$/tsconfig.base.json'],
      outputs: ['dist/**'],
      env: ['NODE_ENV'],
    },
    codegen: { outputs: ['src/gen/**'] },
    lint: { cache: false },
    test: { passThroughEnv: ['CI'], outputs: [] },
  },
}

let root: string

/** A logger that keeps the run:status lines (plugin warnings) in `lines`. */
function silent(): Logger & { lines: string[] } {
  const lines: string[] = []
  const log = {
    lines,
    status: (line: string) => lines.push(line),
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
  }
  return log as unknown as Logger & { lines: string[] }
}

/** What `vx lock` warns here: a mapping's gaps are reported there, never on a run. */
async function lockWarnings(): Promise<string[]> {
  const lines: string[] = []
  await lock(root, (line) => lines.push(line))
  return lines
}

async function pkg(name: string, scripts: Record<string, string>, deps?: Record<string, string>) {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', scripts, ...(deps ? { dependencies: deps } : {}) }),
  )
  await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
  return dir
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-plugin-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'tsconfig.base.json'), '{}')
  // As in any real repo: build output is ignored, so it is nobody's input.
  // Without this, `dist/` written by `app#build` lands in `app#codegen`'s
  // default `**/*` input set and re-keys it on the second run.
  await writeFile(path.join(root, '.gitignore'), 'dist\n')
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(TURBO_JSON, null, 2))
  await pkg('lib', { build: 'mkdir -p dist && echo lib > dist/lib.js' })
  await pkg(
    'app',
    {
      build: 'mkdir -p dist && cat src/gen/api.js > dist/app.js',
      codegen: 'mkdir -p src/gen && echo "// api" > src/gen/api.js',
      lint: 'echo lint',
      test: 'echo test',
    },
    { lib: 'workspace:*' },
  )
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource(['turbo()'], `import { turbo } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('turbo()', () => {
  it(
    'plans a turbo.json workspace with no vx.config: tasks, edges, cache blocks, inlined globals',
    async () => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      const ids = plan.tasks.map((t) => t.node.id).sort()
      expect(ids).toEqual(['app#build', 'app#codegen', 'lib#build'])
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      // `^build` reached lib, `codegen` is a same-package edge.
      expect(app.deps.sort()).toEqual(['app#codegen', 'lib#build'])
      const cache = app.config.cache!
      const inputs = app.config.inputs!
      // `codegen`'s outputs taken back (core X-54).
      expect(inputs.files).toEqual(['**/*', '!**/*.md', '!src/gen/**'])
      // globalDependencies and the $TURBO_ROOT$/ input both name the
      // file; the mapper sees both strings and lists it once.
      expect(inputs.workspaceFiles).toEqual(['tsconfig.base.json'])
      expect(notTurbos(inputs.env!)).toEqual(['GLOBAL_MODE', 'NODE_ENV'])
      expect(cache.outputs.files).toEqual(['dist/**'])
      expect(notTurbos(app.config.exec!.env!.passThrough!)).toEqual([
        'GLOBAL_MODE',
        'AWS_PROFILE',
        'NODE_ENV',
      ])
      expect(app.config.exec?.command).toBe('mkdir -p dist && cat src/gen/api.js > dist/app.js')
    },
    TIMEOUT,
  )

  it(
    'a turbo.json with comments, trailing commas and a top-level "//" note plans as the plain one',
    async () => {
      // Turbo parses turbo.json as JSONC (vercel/turborepo#6810) and skips a
      // top-level `//` key, the ecosystem's comment field (#7546).
      const plan = async () =>
        (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks
          .map((t) => ({ id: t.node.id, deps: [...t.node.deps].sort(), config: t.node.config }))
          .sort((a, b) => a.id.localeCompare(b.id))
      const plain = await plan()
      const body = JSON.stringify(TURBO_JSON, null, 2)
      const commented = body
        .replace('{\n', '{\n  // shared by every package\n  "//": "see docs/turbo.md",\n')
        .replace(
          '"outputs": [\n        "dist/**"\n      ],',
          '"outputs": ["dist/**",], /* built */',
        )
      expect(commented).toContain('/* built */')
      await writeFile(path.join(root, 'turbo.json'), commented)
      expect(await plan()).toEqual(plain)
    },
    TIMEOUT,
  )

  it(
    'a turbo.json spelled with ./ (inputs and outputs) keys the mapped task on its files',
    async () => {
      // The mapper hands globs through as written; core normalizes the
      // spellings a matcher would turn into nothing (`./src/**` folded
      // zero inputs until 2026-09-10). Pinned at this boundary too, since a
      // turbo.json is where the spelling comes from.
      const turbo = structuredClone(TURBO_JSON) as typeof TURBO_JSON & {
        tasks: { build: { inputs: string[]; outputs: string[] } }
      }
      turbo.tasks.build.inputs = ['./src/**']
      turbo.tasks.build.outputs = ['./dist/**']
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo, null, 2))
      const opts = { cwd: root, tasks: ['build'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>, id: string) =>
        r.outcomes.find((o) => o.node.id === id)!.status
      const first = await run(opts)
      expect(first.ok).toBe(true)
      expect(status(first, 'lib#build')).toBe('success')
      expect(status(await run(opts), 'lib#build')).toBe('cache-hit')
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.js'), '// lib v2\n')
      const third = await run(opts)
      expect(status(third, 'lib#build')).toBe('success')
      expect(await Bun.file(path.join(root, 'packages', 'lib', 'dist', 'lib.js')).text()).toBe(
        'lib\n',
      )
    },
    TIMEOUT,
  )

  // Turbo folds the whole pipeline into its global hash (vercel/turborepo
  // #1166): an edit to any task's definition misses every task. vx keys a
  // task on its own resolved config, so only its own definition moves it.
  it(
    "an edit to another task's turbo.json definition keeps the hit; its own re-runs it",
    async () => {
      const opts = { cwd: root, tasks: ['lib#build'], log: silent(), handleSignals: false }
      const status = async () => (await run(opts)).outcomes.map((o) => o.status)
      expect(await status()).toEqual(['success'])
      const turbo = structuredClone(TURBO_JSON)
      turbo.tasks.test.outputs = ['coverage/**'] as never[]
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo, null, 2))
      expect(await status()).toEqual(['cache-hit'])
      turbo.tasks.build.env = ['NODE_ENV', 'BUILD_MODE']
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo, null, 2))
      expect(await status()).toEqual(['success'])
    },
    TIMEOUT,
  )

  it(
    'runs the graph, caches by the mapped blocks, and leaves `cache: false` tasks uncached',
    async () => {
      const first = await run({
        cwd: root,
        tasks: ['build', 'lint'],
        log: silent(),
        handleSignals: false,
      })
      expect(first.ok).toBe(true)
      expect(first.outcomes.map((o) => o.status)).toEqual([
        'success',
        'success',
        'success',
        'success',
      ])
      const second = await run({
        cwd: root,
        tasks: ['build', 'lint'],
        log: silent(),
        handleSignals: false,
      })
      expect(second.ok).toBe(true)
      const byId = new Map(second.outcomes.map((o) => [o.node.id, o]))
      expect(byId.get('lib#build')!.status).toBe('cache-hit')
      expect(byId.get('app#codegen')!.status).toBe('cache-hit')
      expect(byId.get('app#build')!.status).toBe('cache-hit')
      // turbo `cache: false` → no cache block → runs again.
      expect(byId.get('app#lint')!.status).toBe('success')
      expect(byId.get('app#lint')!.node.config.cache).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'a package that wrote its own vx.config keeps its declaration; the plugin only fills',
    async () => {
      await writeFile(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: 'echo by-hand' } } } }`,
      )
      const plan = await planRun({ cwd: root, tasks: ['build', 'test'], log: silent() })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.config.exec?.command).toBe('echo by-hand')
      expect(app.config.cache).toBeUndefined()
      // The tasks the config did not declare are still filled from turbo.json.
      expect(plan.tasks.some((t) => t.node.id === 'app#test')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "outputLogs: new-only is vx's default and warns about nothing; other values name the run flag",
    async () => {
      // `new-only` — frames for what ran, a one-liner per hit — is what vx
      // does by default, and it is the value in every Vercel template; on
      // solidjs/solid every run warned "no vx equivalent" for it twice.
      // The other values have no per-task knob in vx: the todo says which
      // run flag carries them instead of asking for a manual mapping.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: { outputLogs: 'new-only' },
            test: { outputLogs: 'hash-only' },
            lint: { outputLogs: 'loud' },
          },
        }),
      )
      const text = (await lockWarnings()).join('\n')
      expect(text).not.toContain('outputLogs" ("new-only")')
      expect(text).not.toContain('has no vx equivalent')
      expect(text).toContain(
        '[vx] vx-migrate: app#test: turbo key "outputLogs" ("hash-only") is a per-run setting in vx — run with --output-logs hash-only',
      )
      expect(text).toContain(
        '[vx] vx-migrate: app#lint: turbo key "outputLogs" ("loud") is not a value vx knows — run with --output-logs full|hash-only|errors-only|none',
      )
    },
    TIMEOUT,
  )

  it(
    'interruptible maps to nothing: vx watch restarts every persistent task',
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: { interruptible: false },
            test: { persistent: true, interruptible: true },
          },
        }),
      )
      const log = silent()
      await planRun({ cwd: root, tasks: ['build', 'test'], log })
      expect((await lockWarnings()).filter((l) => l.includes('interruptible'))).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'every persistent task is one warning at vx lock, not one per task',
    async () => {
      // n8n marks `dev` and `watch` persistent in most of its 84 packages;
      // a line per task was a hundred identical lines before the first frame.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: { outputs: ['dist/**'] },
            dev: { persistent: true, cache: false },
            watch: { persistent: true, cache: false },
          },
        }),
      )
      for (const name of ['lib', 'app']) {
        const file = path.join(root, 'packages', name, 'package.json')
        const pj = JSON.parse(await Bun.file(file).text()) as { scripts: Record<string, string> }
        pj.scripts['dev'] = 'echo dev'
        pj.scripts['watch'] = 'echo watch'
        await writeFile(file, JSON.stringify(pj))
      }
      // Nothing depends on dev or watch: the readiness note has nothing to
      // gate, so it is not reported at all (item 602).
      expect((await lockWarnings()).filter((l) => l.includes('persistent'))).toEqual([])
      // With a dependent, the note names the tasks it gates — once.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: { outputs: ['dist/**'], dependsOn: ['dev'] },
            dev: { persistent: true, cache: false },
            watch: { persistent: true, cache: false },
          },
        }),
      )
      const lines = (await lockWarnings()).filter((l) => l.includes('persistent'))
      expect(lines).toEqual([
        '[vx] vx-migrate: 2 tasks (dev across 2 packages): persistent in turbo.json — vx runs them as persistent tasks that are ready on spawn; add `exec.persistent.readyWhen` in a vx.config to gate dependents on their output',
      ])
    },
    TIMEOUT,
  )

  it(
    'a ^task no package has a script for is an empty group, as under turbo',
    async () => {
      // turbo.json may name a task no package runs (`prepack` here): Turbo
      // runs a no-op `lib#prepack` before `app#test` (dry run, 2026-10-07).
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: { build: {}, prepack: {}, test: { dependsOn: ['^build', '^prepack'] } },
        }),
      )
      const plan = await planRun({ cwd: root, tasks: ['test'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual([
        'app#test',
        'lib#build',
        'lib#prepack',
      ])
      const test = plan.tasks.find((t) => t.node.id === 'app#test')!.node
      expect(test.deps.toSorted()).toEqual(['lib#build', 'lib#prepack'])
      expect(test.config.dependsOn).toEqual(['^build', '^prepack'])
    },
    TIMEOUT,
  )

  it(
    'a gap shared by many tasks is one warning at vx lock, not written',
    async () => {
      // A nameless root stays no project, so its root task is a note.
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }))
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: { build: { outputs: ['dist/**'], foo: 1 }, '//#root': {} },
        }),
      )
      const text = (await lockWarnings()).join('\n')
      // Once for the workspace note, once for the gap — astro's `build`
      // carried one gap in 57 tasks, and a line per task was 57 identical
      // lines before the first frame (2026-09-11).
      expect(text).toContain(
        '[vx] vx-migrate: 2 tasks (build across 2 packages): turbo key "foo" (1) has no vx equivalent',
      )
      expect(text).not.toContain('app#build: output')
      expect(text).toContain('[vx] vx-migrate: note: root task //#root not migrated')
      expect(text.split('root task //#root').length - 1).toBe(1)
      expect(text.split('has no vx equivalent').length - 1).toBe(1)
    },
    TIMEOUT,
  )
})

// Turbo's transit node (its with-vitest example): no script anywhere,
// `transit: ^transit`, and `test` depends on it, so a dependency's edit
// re-runs a dependant's `test`. Dropped, the key missed it: a stale hit.
describe('a transit node', () => {
  it(
    "keys a dependant's task on its dependencies' sources",
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            transit: { dependsOn: ['^transit'] },
            test: { dependsOn: ['transit'], inputs: ['src/**'] },
          },
        }),
      )
      await writeFile(
        path.join(root, 'packages', 'app', 'package.json'),
        JSON.stringify({
          name: 'app',
          dependencies: { lib: 'workspace:*' },
          scripts: { test: 'echo t' },
        }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const key = async () => {
        const plan = await planRun({ cwd: root, tasks: ['app#test'], log: silent() })
        return plan.tasks.find((t) => t.node.id === 'app#test')!.hash
      }
      const before = await key()
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.js'), '// edited\n')
      expect(await key()).not.toBe(before)
    },
    TIMEOUT,
  )
})

// with-vite: `ui` has no `build`, its apps bundle it, and Turbo hashes
// its no-op `ui#build` into theirs. Walked past, an edit to ui replayed
// both apps' builds from the cache.
// create-t3-turbo: `topo: { dependsOn: ["^topo"] }` with no script anywhere, and
// `typecheck: { dependsOn: ["^topo"] }`. Reached only through `^topo`, the
// node was dropped with its edges, and a dependency's edit replayed the
// dependant's typecheck.
describe('a transit node reached through `^name`', () => {
  it(
    "keys a dependant's task on its dependencies' sources",
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            topo: { dependsOn: ['^topo'] },
            typecheck: { dependsOn: ['^topo'], inputs: ['src/**'] },
          },
        }),
      )
      await writeFile(
        path.join(root, 'packages', 'app', 'package.json'),
        JSON.stringify({
          name: 'app',
          dependencies: { lib: 'workspace:*' },
          scripts: { typecheck: 'echo t' },
        }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const key = async () => {
        const plan = await planRun({ cwd: root, tasks: ['app#typecheck'], log: silent() })
        return plan.tasks.find((t) => t.node.id === 'app#typecheck')!.hash
      }
      const before = await key()
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.js'), '// edited\n')
      expect(await key()).not.toBe(before)
    },
    TIMEOUT,
  )
})

describe("a package without a task's script that others run", () => {
  it(
    'keys its dependants on its sources, and cleans nothing of its own',
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }),
      )
      await pkg('lib', { lint: 'echo l' })
      const lib = path.join(root, 'packages', 'lib')
      await mkdir(path.join(lib, 'dist'), { recursive: true })
      await writeFile(path.join(lib, 'dist', 'kept.js'), 'kept\n')
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const key = async () => {
        const plan = await planRun({ cwd: root, tasks: ['app#build'], log: silent() })
        return plan.tasks.find((t) => t.node.id === 'app#build')!.hash
      }
      const before = await key()
      await writeFile(path.join(lib, 'src', 'index.js'), '// edited\n')
      expect(await key()).not.toBe(before)
      const result = await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      expect(result.outcomes.find((o) => o.node.id === 'lib#build')?.status).toBe('success')
      expect(await Bun.file(path.join(lib, 'dist', 'kept.js')).text()).toBe('kept\n')
    },
    TIMEOUT,
  )
})

describe('root tasks (D-39)', () => {
  const setUp = async (rootConfig: boolean, name: string | null = 'ws') => {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        ...(name !== null ? { name } : {}),
        private: true,
        scripts: { gen: 'mkdir -p out && echo g > out/g.txt' },
      }),
    )
    await writeFile(path.join(root, '.gitignore'), 'dist\nout\n')
    await pkg('app', { build: 'cat ../../out/g.txt' })
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: { '//#gen': { outputs: ['out/**'] }, build: { dependsOn: ['//#gen'] } },
      }),
    )
    if (rootConfig)
      await writeFile(path.join(root, 'vx.config.mjs'), 'export default { tasks: {} }\n')
  }

  it(
    "a root with a vx.config runs Turbo's `//#task`, and `//#gen` is an edge to it",
    async () => {
      await setUp(true)
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['app#build'], log })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual(['app#build', 'ws#gen'])
      expect(plan.tasks.find((t) => t.node.id === 'app#build')!.node.deps).toEqual(['ws#gen'])
      expect((await lockWarnings()).join('\n')).not.toContain('root task')
      const result = await run({
        cwd: root,
        tasks: ['app#build'],
        log: silent(),
        handleSignals: false,
      })
      expect(result.ok).toBe(true)
      expect(await Bun.file(path.join(root, 'out', 'g.txt')).text()).toBe('g\n')
    },
    TIMEOUT,
  )

  // Turbo hashes a root task over the whole repo. As the root project's own
  // `**/*`, core stopped its globs at every member (D-39): a root lint over
  // the repo replayed green after a member file broke (react-notion-x).
  it(
    "a root task's inputs are the workspace's: a member edit re-keys it",
    async () => {
      await setUp(true)
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({
          name: 'ws',
          private: true,
          scripts: { gen: 'mkdir -p out && cat packages/app/src/index.js > out/g.txt' },
        }),
      )
      const gen = async () => {
        const r = await run({ cwd: root, tasks: ['ws#gen'], log: silent(), handleSignals: false })
        expect(r.ok).toBe(true)
        return Bun.file(path.join(root, 'out', 'g.txt')).text()
      }
      expect(await gen()).toBe('// app\n')
      await writeFile(path.join(root, 'packages', 'app', 'src', 'index.js'), '// edited\n')
      expect(await gen()).toBe('// edited\n')
    },
    TIMEOUT,
  )

  // A create-turbo repo's `//#format` over a root script: `vx run format
  // --all` said "No projects declare task(s)" until turbo() named the root
  // through `discover`.
  it(
    'with no root vx.config, turbo() makes the root a project: `//#gen` runs under --all',
    async () => {
      await setUp(false)
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['app#build'], log })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual(['app#build', 'ws#gen'])
      expect((await lockWarnings()).join('\n')).not.toContain('root task')
      const result = await run({ cwd: root, tasks: ['gen'], log: silent(), handleSignals: false })
      expect(result.ok).toBe(true)
      expect(await Bun.file(path.join(root, 'out', 'g.txt')).text()).toBe('g\n')
    },
    TIMEOUT,
  )

  it(
    'CONTROL: a nameless root is no project; the root task is a note and the edge a todo',
    async () => {
      await setUp(false, null)
      const text = (await lockWarnings()).join('\n')
      const plan = await planRun({ cwd: root, tasks: ['app#build'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['app#build'])
      expect(text).toContain(
        'note: root task //#gen not migrated — the workspace root is no project; a root package.json name no package holds makes it one',
      )
      expect(text).toContain(
        'dependsOn "//#gen": the workspace root is no project — edge dropped; a root package.json name no package holds makes it one',
      )
    },
    TIMEOUT,
  )
})

describe('turbo.json is a claimed root file (item 961)', () => {
  it('turbo() claims turbo.json at the root and cannot tell which tasks an edit moved', () => {
    const claim = turbo().fingerprint!
    expect([...claim.files]).toEqual(['turbo.json', 'turbo.jsonc'])
    expect(claim.affected({ file: 'turbo.json', before: null, after: null }, {} as never)).toBe(
      undefined,
    )
    // A turbo.json elsewhere is no root name; nothing is claimed.
    expect(turbo({ root: path.join(root, 'sub') }).fingerprint).toBeUndefined()
  })

  it(
    'an edit to turbo.json selects every project under --affected',
    async () => {
      // It re-keyed every mapped task, and no project owns the path: the
      // run said nothing affected and exited 0.
      const git = (...args: string[]) =>
        Bun.spawnSync({
          cmd: [
            'git',
            '-c',
            'user.email=t@vx.local',
            '-c',
            'user.name=vx',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          cwd: root,
          stderr: 'pipe',
        })
      const commit = git('commit', '-qm', 'init')
      expect({ code: commit.exitCode, err: commit.stderr.toString() }).toEqual({ code: 0, err: '' })
      const edited = { ...TURBO_JSON, globalEnv: ['GLOBAL_MODE', 'OTHER'] }
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify(edited, null, 2))
      const p = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.resolve(import.meta.dir, '..', '..', 'vx', 'tests', 'helpers', 'vx-locked.ts'),
          'run',
          'lint',
          '--affected=HEAD',
          '--dry=json',
        ],
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
      })
      expect({ code: p.exitCode, err: p.stderr.toString() }).toEqual({ code: 0, err: '' })
      const ids = (JSON.parse(p.stdout.toString()) as { tasks: { id: string }[] }).tasks.map(
        (t) => t.id,
      )
      expect(ids).toEqual(['app#lint'])
    },
    TIMEOUT,
  )
})

describe('a committed file under an output', () => {
  // typescript-eslint's website build caches `data`, which holds the
  // committed `sponsors.json`: Turbo and Nx never clean an output, vx does,
  // and the first run deleted it (2026-09-29). Core never cleans a
  // committed file (2026-10-14), so the output stays as declared.
  it(
    'survives the clean, and the task keeps its cache',
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['data/**'] } } }),
      )
      const app = path.join(root, 'packages', 'app')
      await pkg('app', { build: 'mkdir -p data && echo gen > data/gen.json' })
      await mkdir(path.join(app, 'data'), { recursive: true })
      await writeFile(path.join(app, 'data', 'sponsors.json'), '["committed"]\n')
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['app#build'], log })
      const node = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(node.config.cache!.outputs.files).toEqual(['data/**'])
      expect((await lockWarnings()).join('\n')).not.toContain('committed')
      const opts = { cwd: root, tasks: ['app#build'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>) =>
        r.outcomes.find((o) => o.node.id === 'app#build')!.status
      expect(status(await run(opts))).toBe('success')
      expect(status(await run(opts))).toBe('cache-hit')
      expect(await Bun.file(path.join(app, 'data', 'sponsors.json')).text()).toBe('["committed"]\n')
      expect(await Bun.file(path.join(app, 'data', 'gen.json')).text()).toBe('gen\n')
    },
    TIMEOUT,
  )
})

describe('input zero segments', () => {
  it(
    "a wildcard `X/**` input also keys on X, as Turbo's `**` matches zero segments",
    async () => {
      const app = path.join(root, 'packages', 'app')
      await pkg('app', { build: 'mkdir -p dist && cat config.json > dist/out.json' })
      await pkg('lib', { build: 'mkdir -p dist && echo l > dist/l.js' })
      await writeFile(path.join(app, 'config.json'), '{"v":1}\n')
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: { build: { inputs: ['*/**', '!*.md', '!dist-*/**'], outputs: ['dist/**'] } },
        }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const plan = await planRun({ cwd: root, tasks: ['app#build'], log: silent() })
      const node = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(node.config.inputs?.files).toEqual(['*/**', '*', '!*.md', '!dist-*/**', '!dist-*'])
      const opts = { cwd: root, tasks: ['app#build'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>) =>
        r.outcomes.find((o) => o.node.id === 'app#build')!.status
      expect(status(await run(opts))).toBe('success')
      expect(status(await run(opts))).toBe('cache-hit')
      // Matched only through `*/**`'s zero segments: a hit here replays `{"v":1}`.
      await writeFile(path.join(app, 'config.json'), '{"v":2}\n')
      expect(status(await run(opts))).toBe('success')
      expect(await Bun.file(path.join(app, 'dist', 'out.json')).text()).toBe('{"v":2}\n')
    },
    TIMEOUT,
  )

  it(
    'a root task takes X as a workspace glob; $TURBO_DEFAULT$ and literal inputs are unchanged',
    async () => {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true, scripts: { gen: 'echo g' } }),
      )
      await writeFile(path.join(root, 'vx.config.mjs'), 'export default { tasks: {} }\n')
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            '//#gen': { inputs: ['*/**'] },
            build: { inputs: ['$TURBO_DEFAULT$', 'package.json', 'src/**'] },
          },
        }),
      )
      const plan = await planRun({ cwd: root, tasks: ['ws#gen', 'lib#build'], log: silent() })
      const inputs = (id: string) => plan.tasks.find((t) => t.node.id === id)!.node.config.inputs!
      expect(inputs('ws#gen').workspaceFiles).toEqual(['*/**', '*'])
      expect(inputs('lib#build').files).toEqual(['**/*', 'package.json', 'src/**'])
    },
    TIMEOUT,
  )
})

// turborepo#1832: Turbo hashes a package's package.json beside any explicit
// `inputs`. Mapped without it, an edit to a field the build reads (here
// `type`) replayed the old output.
describe("the package's package.json with explicit inputs", () => {
  it(
    'an edit to it re-runs a task whose inputs name only src',
    async () => {
      const app = path.join(root, 'packages', 'app')
      const manifest = (type: string) =>
        JSON.stringify({ name: 'app', version: '1.0.0', type, scripts: { build: BUILD } })
      const BUILD = 'mkdir -p dist && cp package.json dist/pkg.json'
      await writeFile(path.join(app, 'package.json'), manifest('commonjs'))
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { inputs: ['src/**'], outputs: ['dist/**'] } } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const opts = { cwd: root, tasks: ['app#build'], log: silent(), handleSignals: false }
      const status = (r: Awaited<ReturnType<typeof run>>) =>
        r.outcomes.find((o) => o.node.id === 'app#build')!.status
      expect(status(await run(opts))).toBe('success')
      expect(status(await run(opts))).toBe('cache-hit')
      await writeFile(path.join(app, 'package.json'), manifest('module'))
      expect(status(await run(opts))).toBe('success')
      expect(await Bun.file(path.join(app, 'dist', 'pkg.json')).text()).toBe(manifest('module'))
    },
    TIMEOUT,
  )
})

describe('output negation', () => {
  it(
    'a wildcard output carved by negations stays cached and names what the clean deletes',
    async () => {
      // medusa: `outputs: ["!node_modules/**", "!src/**", "*/**", ".medusa/**"]`.
      // `*/**` reaches every dir the negations do not name; committed files
      // there are taken back, untracked ones are cleaned (EA, 2026-10-14:
      // nx()'s rule), and the sources under `src` survive a real run.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: {
            build: {
              dependsOn: ['codegen'],
              outputs: ['!node_modules/**', '!src/**', '*/**', '.medusa/**'],
            },
            codegen: { outputs: ['src/gen/**'] },
          },
        }),
      )
      const warned = (await lockWarnings()).join('\n')
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.config.cache?.outputs.files).toEqual([
        '*',
        '*/**',
        '.medusa/**',
        '!node_modules/**',
        '!package.json',
        '!src/**',
      ])
      expect(warned).toContain(
        '[vx] vx-migrate: 2 tasks (build across 2 packages): output "*/**": vx cleans outputs before a run and a restore, so every untracked file this glob reaches is deleted; committed files are kept',
      )
      const result = await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      expect(result.ok).toBe(true)
      expect(
        await Bun.file(path.join(root, 'packages', 'app', 'src', 'gen', 'api.js')).exists(),
      ).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "a wildcard `X/**` output also matches X, as Turbo's `**` matches zero segments (medusa `*/**`)",
    async () => {
      // medusa's framework build writes `tsconfig.tsbuildinfo` at the package
      // root; Turbo's artifact for `*/**` held it, vx's restore did not.
      const script = 'mkdir -p lib && echo t > tsconfig.tsbuildinfo && echo l > lib/x.js'
      await pkg('app', { build: script })
      await pkg('lib', { build: script })
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['!node_modules/**', '!src/**', '*/**'] } } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.config.cache?.outputs.files).toEqual([
        '*',
        '*/**',
        '!node_modules/**',
        '!package.json',
        '!src/**',
      ])
      const build = () => run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      const dir = path.join(root, 'packages', 'app')
      const info = path.join(dir, 'tsconfig.tsbuildinfo')
      expect((await build()).ok).toBe(true)
      await rm(info)
      const second = await build()
      expect(second.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await Bun.file(info).text()).toBe('t\n')
      expect(await Bun.file(path.join(dir, 'package.json')).exists()).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a dir at any depth the package tracks nothing under stays cached (vercel/ai `**/dist/**`)',
    async () => {
      await pkg('app', {
        build: 'mkdir -p dist rsc/dist && echo a > dist/a.js && echo r > rsc/dist/r.js',
      })
      await pkg('lib', { build: 'mkdir -p dist && echo l > dist/l.js' })
      const lib = path.join(root, 'packages', 'lib')
      await mkdir(path.join(lib, 'src', 'dist'), { recursive: true })
      await writeFile(path.join(lib, 'src', 'dist', 'keep.js'), 'kept\n')
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['**/dist/**'] } } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      // Committed despite the ignore rule, as a vendored file would be.
      Bun.spawnSync({ cmd: ['git', 'add', '-f', 'packages/lib/src/dist/keep.js'], cwd: root })
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const cacheOf = (id: string) => plan.tasks.find((t) => t.node.id === id)!.node.config.cache
      expect(cacheOf('app#build')?.outputs.files).toEqual(['**/dist', '**/dist/**'])
      // CONTROL: lib commits a file the glob reaches; the output stays as declared.
      expect(cacheOf('lib#build')?.outputs.files).toEqual(['**/dist', '**/dist/**'])
      const build = () => run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      const nested = path.join(root, 'packages', 'app', 'rsc', 'dist', 'r.js')
      expect((await build()).ok).toBe(true)
      await rm(nested)
      const second = await build()
      expect(second.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await Bun.file(nested).text()).toBe('r\n')
      expect(await Bun.file(path.join(lib, 'src', 'dist', 'keep.js')).text()).toBe('kept\n')
    },
    TIMEOUT,
  )

  it(
    'a top-level output of a kind the package tracks none of stays cached (n8n `*.xml`)',
    async () => {
      await pkg('app', { test: 'echo report > junit.xml' })
      await pkg('lib', { test: 'echo report > junit.xml' })
      const lib = path.join(root, 'packages', 'lib')
      await writeFile(path.join(lib, 'pom.xml'), '<project/>\n')
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { test: { outputs: ['coverage/**', '*.xml'] } } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['test'], log })
      const cacheOf = (id: string) => plan.tasks.find((t) => t.node.id === id)!.node.config.cache
      expect(cacheOf('app#test')?.outputs.files).toEqual(['*.xml', 'coverage/**'])
      // CONTROL: lib commits a file the glob reaches; the output stays as declared.
      expect(cacheOf('lib#test')?.outputs.files).toEqual(['*.xml', 'coverage/**'])
      const test = () => run({ cwd: root, tasks: ['test'], log: silent(), handleSignals: false })
      const report = path.join(root, 'packages', 'app', 'junit.xml')
      expect((await test()).ok).toBe(true)
      await rm(report)
      const second = await test()
      expect(second.outcomes.find((o) => o.node.id === 'app#test')?.status).toBe('cache-hit')
      expect(await Bun.file(report).text()).toBe('report\n')
      expect(await Bun.file(path.join(lib, 'pom.xml')).text()).toBe('<project/>\n')
    },
    TIMEOUT,
  )

  it(
    'a first segment no tracked top-level entry matches stays cached (tldraw `dist-*/**`)',
    async () => {
      await pkg('app', { build: 'mkdir -p dist-esm && echo a > dist-esm/a.js' })
      await pkg('lib', { build: 'mkdir -p dist-esm && echo l > dist-esm/l.js' })
      const lib = path.join(root, 'packages', 'lib')
      await mkdir(path.join(lib, 'dist-types'), { recursive: true })
      await writeFile(path.join(lib, 'dist-types', 'keep.d.ts'), 'kept\n')
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['dist-*/**'] } } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      Bun.spawnSync({ cmd: ['git', 'add', '-f', 'packages/lib/dist-types/keep.d.ts'], cwd: root })
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const cacheOf = (id: string) => plan.tasks.find((t) => t.node.id === id)!.node.config.cache
      expect(cacheOf('app#build')?.outputs.files).toEqual(['dist-*', 'dist-*/**'])
      // CONTROL: lib commits a file the glob reaches; the output stays as declared.
      expect(cacheOf('lib#build')?.outputs.files).toEqual(['dist-*', 'dist-*/**'])
      const build = () => run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
      const out = path.join(root, 'packages', 'app', 'dist-esm', 'a.js')
      expect((await build()).ok).toBe(true)
      await rm(out)
      const second = await build()
      expect(second.outcomes.find((o) => o.node.id === 'app#build')?.status).toBe('cache-hit')
      expect(await Bun.file(out).text()).toBe('a\n')
      expect(await Bun.file(path.join(lib, 'dist-types', 'keep.d.ts')).text()).toBe('kept\n')
    },
    TIMEOUT,
  )

  it(
    'a top-level output beside a config of its spelling takes that config back (sanity `*.js`)',
    async () => {
      await pkg('app', { build: 'echo shim > cli.mjs' })
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['lib/**', '*.mjs'] } } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const cacheOf = async () =>
        (await planRun({ cwd: root, tasks: ['app#build'], log: silent() })).tasks.find(
          (t) => t.node.id === 'app#build',
        )!.node.config.cache
      expect((await cacheOf())?.outputs.files).toEqual(['*.mjs', 'lib/**'])
      // A config the mapped task now lives beside: the kept mapping is
      // re-made, and the output takes the config back.
      await writeFile(
        path.join(root, 'packages', 'app', 'vx.config.mjs'),
        'export default { tasks: {} }\n',
      )
      expect((await cacheOf())?.outputs.files).toEqual(['*.mjs', 'lib/**', '!vx.config.mjs'])
    },
    TIMEOUT,
  )

  it(
    "Next's `!.next/cache/**` keeps the cache out of the clean and the artifact (A-44)",
    async () => {
      await writeFile(path.join(root, '.gitignore'), 'dist\n.next\n')
      await pkg('app', {
        build: 'mkdir -p .next/cache && echo out > .next/out.js && echo run >> .next/cache/runs',
      })
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['.next/**', '!.next/cache/**'] } } }),
      )
      const app = path.join(root, 'packages', 'app')
      const build = () =>
        run({ cwd: root, tasks: ['app#build'], log: silent(), handleSignals: false })
      const runs = () => Bun.file(path.join(app, '.next', 'cache', 'runs')).text()
      expect((await build()).ok).toBe(true)
      await rm(path.join(app, '.next', 'out.js'))
      expect((await build()).ok).toBe(true)
      // The hit restored the output and left the cache as it was.
      expect(await Bun.file(path.join(app, '.next', 'out.js')).text()).toBe('out\n')
      expect(await runs()).toBe('run\n')
      await writeFile(path.join(app, 'src', 'index.js'), '// edited\n')
      expect((await build()).ok).toBe(true)
      // The miss ran on the cache the last run left: no clean took it.
      expect(await runs()).toBe('run\nrun\n')
    },
    TIMEOUT,
  )
})

describe('per-package turbo.json', () => {
  it(
    'extends: false alone opts the package out of the task; with keys it runs on those keys alone',
    async () => {
      // n8n's @n8n/storybook: root defines build/test, the package has the
      // scripts, its turbo.json says `{ "extends": false }` — Turbo 2.9
      // runs nothing for it (probed 2026-09-11). With another key the task
      // runs on that key alone: no `^build` edge from the root.
      await writeFile(
        path.join(root, 'packages', 'app', 'turbo.json'),
        JSON.stringify({
          extends: ['//'],
          tasks: { build: { extends: false, outputs: ['dist/**'] }, lint: { extends: false } },
        }),
      )
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const ids = plan.tasks.map((t) => t.node.id).sort()
      expect(ids, log.lines.join('\n')).toEqual(['app#build', 'lib#build'])
      // No package has a `lint` script: Turbo's no-op node, in lib alone.
      const lint = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(lint.tasks.map((t) => t.node.id)).toEqual(['lib#lint'])
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.deps).toEqual([])
      expect(app.config.inputs?.files).toEqual(['**/*', '!src/gen/**'])
    },
    TIMEOUT,
  )

  it(
    'a glob that climbs out of the package is re-anchored on the workspace root',
    async () => {
      // cal.com's app-store-cli#build writes `../../packages/app-store/
      // *.generated.ts`; as a project-relative output core refuses the
      // config and the whole run aborts. It is a workspace glob.
      await writeFile(
        path.join(root, 'packages', 'app', 'turbo.json'),
        JSON.stringify({
          extends: ['//'],
          tasks: {
            build: {
              inputs: ['src/**', '../lib/src/**', '!../lib/src/**/*.test.ts'],
              outputs: ['dist/**', '../lib/generated/**', '../../../elsewhere/**'],
            },
          },
        }),
      )
      const warned = (await lockWarnings()).join('\n')
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      const cache = app.config.cache!
      const inputs = app.config.inputs!
      expect(inputs.files).toEqual(['src/**', 'package.json', '!src/gen/**'])
      expect(inputs.workspaceFiles).toEqual([
        'tsconfig.base.json',
        'packages/lib/src/**',
        '!packages/lib/src/**/*.test.ts',
      ])
      expect(cache.outputs.files).toEqual(['dist/**'])
      expect(cache.outputs.workspaceFiles).toEqual(['packages/lib/generated/**'])
      expect(warned).toContain(
        'output "../../../elsewhere/**": leaves the workspace — map manually',
      )
    },
    TIMEOUT,
  )

  it(
    'a climbed glob escapes the package dir it keeps, so a brace in its name stays literal',
    async () => {
      await writeFile(
        path.join(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n  - "nested/*/*"\n',
      )
      const web = path.join(root, 'nested', 'g{1}', 'web')
      await mkdir(web, { recursive: true })
      await writeFile(
        path.join(web, 'package.json'),
        JSON.stringify({ name: 'web', version: '1.0.0', scripts: { build: 'echo web' } }),
      )
      await writeFile(
        path.join(web, 'turbo.json'),
        JSON.stringify({ extends: ['//'], tasks: { build: { inputs: ['../shared/**'] } } }),
      )
      const plan = await planRun({ cwd: root, tasks: ['web#build'], log: silent() })
      const node = plan.tasks.find((t) => t.node.id === 'web#build')!.node
      expect(node.config.inputs?.workspaceFiles).toEqual([
        'tsconfig.base.json',
        'nested/g\\{1\\}/shared/**',
      ])
    },
    TIMEOUT,
  )
})

describe('the mapping reads the projects the run has', () => {
  it('maps a project in ctx.projects that no member glob lists — the project stage walks nothing itself', async () => {
    const plugin = turbo()
    const dir = path.join(root, 'elsewhere', 'ghost')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'ghost', version: '1.0.0', scripts: { build: 'echo ghost' } }),
    )
    const ghost: ProjectMeta = { name: 'ghost', dir, configPath: null }
    const config: ProjectConfig = { tasks: {} }
    await plugin.project!(config, {
      workspaceRoot: root,
      cacheDir: path.join(root, '.vx'),
      warn() {},
      name: ghost.name,
      dir: ghost.dir,
      projects: [ghost],
      lock: false,
    })
    expect(config.tasks?.build?.exec?.command).toBe('echo ghost')
  })
})

describe('one mapping per run', () => {
  it(
    "a package.json script edited between two runs in one process is the second run's command (the vx watch shape)",
    async () => {
      // The workspace module is reused across runs in a process (its import
      // is keyed on the file's bytes), so the plugin instance is too; a
      // mapping memoized for the process ran the cycle after this edit on
      // the old command.
      const first = await planRun({ cwd: root, tasks: ['build'], projects: ['lib'], log: silent() })
      expect(first.tasks[0]!.node.config.exec?.command).toBe(
        'mkdir -p dist && echo lib > dist/lib.js',
      )
      await writeFile(
        path.join(root, 'packages', 'lib', 'package.json'),
        JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { build: 'echo lib-v2' } }),
      )
      const second = await planRun({
        cwd: root,
        tasks: ['build'],
        projects: ['lib'],
        log: silent(),
      })
      expect(second.tasks[0]!.node.config.exec?.command).toBe('echo lib-v2')
    },
    TIMEOUT,
  )
})

// Item 816's sweep of turbo/index.ts: the row fails with the line undone.
describe('turbo(): what the sweep found unheld', () => {
  it(
    '`root` names where turbo.json lives',
    async () => {
      await mkdir(path.join(root, 'cfg'))
      await writeFile(
        path.join(root, 'cfg', 'turbo.json'),
        JSON.stringify({ tasks: { lint: { cache: false } } }),
      )
      await rm(path.join(root, 'turbo.json'))
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource(
          [`turbo({ root: ${JSON.stringify(path.join(root, 'cfg'))} })`],
          `import { turbo } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
        ),
      )
      const plan = await planRun({ cwd: root, tasks: ['lint'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['app#lint'])
    },
    TIMEOUT,
  )
})

// Item 1032: Turbo hashes the `.env` files turbo.json names although git
// ignores them; vx keyed only what git reports, so an edit to one replayed
// the build made with the old value. create-turbo's own
// `globalDependencies: ['**/.env.*local']` and a task's `.env*` input.
describe('`.env` inputs', () => {
  it(
    'a gitignored .env file a task or the root names re-keys the task',
    async () => {
      await writeFile(path.join(root, '.gitignore'), 'dist\n.env*.local\n')
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          globalDependencies: ['**/.env.*local'],
          tasks: { build: { inputs: ['$TURBO_DEFAULT$', '.env*'], outputs: ['dist/**'] } },
        }),
      )
      const envFile = path.join(root, 'packages', 'lib', '.env.local')
      const rootEnv = path.join(root, '.env.local')
      await writeFile(envFile, 'SECRET=1\n')
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const key = async () =>
        (await planRun({ cwd: root, tasks: ['build'], log: silent() })).tasks.find(
          (t) => t.node.id === 'lib#build',
        )!.hash
      const first = await key()
      await writeFile(envFile, 'SECRET=2\n')
      const pkgEdit = await key()
      await writeFile(rootEnv, 'ROOT=1\n')
      const rootEdit = await key()
      expect({
        pkgMoved: pkgEdit !== first,
        rootMoved: rootEdit !== pkgEdit,
        stable: (await key()) === rootEdit,
      }).toEqual({ pkgMoved: true, rootMoved: true, stable: true })
    },
    TIMEOUT,
  )
})

// The mapping is kept under the cache dir, keyed on everything it reads
// (G-10, `mapping-cache.ts`). The kept file is tampered with between runs,
// so a row sees which one ran.
describe('turbo(): the mapping cache', () => {
  const lint = async (): Promise<string | undefined> =>
    (await planRun({ cwd: root, tasks: ['lint'], log: silent() })).tasks.find(
      (t) => t.node.id === 'app#lint',
    )!.node.config.exec?.command

  it('a second run serves the kept mapping', async () => {
    expect(await lint()).toBe('echo lint')
    await tamperMapping(root, 'turbo')
    expect(await lint()).toBe('echo from-cache')
  })

  it.each([
    [
      'the root turbo.json',
      () =>
        writeFile(
          path.join(root, 'turbo.json'),
          JSON.stringify({ tasks: { ...TURBO_JSON.tasks, lint: { cache: false, env: ['X'] } } }),
        ),
      'echo lint',
    ],
    [
      'a package turbo.json',
      () =>
        writeFile(
          path.join(root, 'packages', 'app', 'turbo.json'),
          JSON.stringify({ extends: ['//'], tasks: { lint: { cache: false } } }),
        ),
      'echo lint',
    ],
    [
      'a package turbo.jsonc',
      () =>
        writeFile(
          path.join(root, 'packages', 'app', 'turbo.jsonc'),
          '{ "extends": ["//"], "tasks": { "lint": { "cache": false } } }',
        ),
      'echo lint',
    ],
    [
      'the .yarnrc.yml',
      () => writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: pnp\n'),
      'yarn run lint',
    ],
    [
      'a package manifest',
      () =>
        writeFile(
          path.join(root, 'packages', 'app', 'package.json'),
          JSON.stringify({ name: 'app', version: '1.0.0', scripts: { lint: 'echo lint2' } }),
        ),
      'echo lint2',
    ],
  ])('an edit to %s maps afresh', async (_what, edit, expected) => {
    await lint()
    await tamperMapping(root, 'turbo')
    await edit()
    expect(await lint()).toBe(expected)
  })
  // An empty turbo.json is not an absent one: Turbo refuses it beside a
  // turbo.jsonc (vercel/turborepo#10083); keyed alike, a hit ran the old mapping.
  it('an empty turbo.json beside a turbo.jsonc maps afresh, and is refused', async () => {
    const dir = path.join(root, 'packages', 'app')
    await writeFile(path.join(dir, 'turbo.jsonc'), '{ "extends": ["//"], "tasks": {} }')
    await lint()
    await tamperMapping(root, 'turbo')
    await writeFile(path.join(dir, 'turbo.json'), '')
    await expect(lint()).rejects.toThrow('packages/app holds both turbo.json and turbo.jsonc')
  })

  // A hit is the whole mapping: its notes and todos warn as the miss did.
  // Restored as nothing, a cached run dropped every warning.
  it('a hit warns what the miss warned', async () => {
    // A nameless root stays no project, so its root task is a note.
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }))
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: { ...TURBO_JSON.tasks, lint: { cache: false, tagz: ['ci'] }, '//#fmt': {} },
      }),
    )
    const miss = await lockWarnings()
    await tamperMapping(root, 'turbo')
    expect({
      hasNote: miss.some((l) => l.includes('//#fmt')),
      hasTodo: miss.some((l) => l.includes('tagz')),
    }).toEqual({ hasNote: true, hasTodo: true })
    expect(await lockWarnings()).toEqual(miss)
  })

  // Keeping the mapping is best-effort: a cache dir it cannot write to
  // costs the next run a mapping, never this run.
  it('a mapping that cannot be kept still plans the run', async () => {
    await lint()
    const [file] = await Array.fromAsync(
      new Bun.Glob('**/vx-migrate-turbo-mapping.json').scan({ cwd: root, dot: true }),
    )
    await rm(path.join(root, file!))
    await mkdir(path.join(root, file!, 'blocker'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: 'app', version: '1.0.0', scripts: { lint: 'echo lint3' } }),
    )
    expect(await lint()).toBe('echo lint3')
  })
})

// Every run reads configs from the lock, on real Turbo repos too: the
// plugin's tasks are no vx.config, so the lock records none of them and a
// run maps turbo.json live. A config written after the lock waits for
// `vx lock`: the run maps the package as before, and `--check` names it.
describe('turbo() under vx lock', () => {
  const vx = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: [
        process.execPath,
        path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts'),
        ...args,
      ],
      cwd: root,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
  }

  it(
    'locks, runs from the lock, hits on the second run, and runs no config the lock lacks',
    async () => {
      expect(vx('lock')).toEqual({
        code: 0,
        out: '✓ vx lock  0 project configs → .vx/projects.lock.json (no vx.config, so not locked: app, lib)\n',
        err: '',
      })
      const first = vx('run', 'build', '--all')
      expect({ code: first.code, err: first.err }).toEqual({ code: 0, err: '' })
      expect(await Bun.file(path.join(root, 'packages', 'app', 'dist', 'app.js')).text()).toBe(
        '// api\n',
      )
      const second = vx('run', 'build', '--all')
      expect({ code: second.code, err: second.err }).toEqual({ code: 0, err: '' })
      expect(second.out).toContain('3✓')
      await writeFile(
        path.join(root, 'packages', 'lib', 'vx.config.mjs'),
        'export default { tasks: { build: { exec: { command: "true" } } } }\n',
      )
      const third = vx('run', 'build', '--all')
      // The new file is an input of the mapped build, which re-runs; the config is not read.
      expect({ code: third.code, err: third.err }).toEqual({ code: 0, err: '' })
      expect(third.out).toContain('lib#build')
      expect(vx('lock', '--check')).toEqual({
        code: 1,
        out: '',
        err: "✗ vx lock --check  packages/lib/vx.config.mjs is not in the lock — run 'vx lock'\n",
      })
    },
    TIMEOUT,
  )

  // solid-js (2026-10-15): two tasks on one output path printed the
  // gap on every run and never at `vx lock`. Runs check nothing; the lock
  // reports what the mapping could not say, once, as a warning.
  it(
    'reports a mapping gap at vx lock and --check, never on a run',
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: { build: { outputs: ['dist/**'] }, types: { outputs: ['dist/**'] } },
        }),
      )
      await pkg('lib', { build: 'mkdir -p dist && echo lib > dist/lib.js', types: 'true' })
      const gap = 'lib#types: declares the output'
      const lock = vx('lock')
      expect({ code: lock.code, gap: lock.err.includes(gap) }).toEqual({ code: 0, gap: true })
      expect(lock.err.split(gap).length - 1).toBe(1)
      const check = vx('lock', '--check')
      expect({ code: check.code, gap: check.err.includes(gap) }).toEqual({ code: 0, gap: true })
      const ran = vx('run', 'lib#build')
      expect({ code: ran.code, err: ran.err, out: ran.out.includes('declares the') }).toEqual({
        code: 0,
        err: '',
        out: false,
      })
    },
    TIMEOUT,
  )
})

// with-microfrontends: Turbo appends every package's microfrontends config
// to the root's global deps, so an edit to `web`'s routes re-keys every
// task. Unread, the sibling apps' builds replayed from the cache.
describe('a microfrontends config', () => {
  it(
    "re-keys every package's tasks, as Turbo's global deps do; a child's partOf does not",
    async () => {
      const web = await pkg('web', { build: 'echo web' })
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const key = async () => {
        const plan = await planRun({ cwd: root, tasks: ['lib#build'], log: silent() })
        return plan.tasks.find((t) => t.node.id === 'lib#build')!.hash
      }
      const before = await key()
      await writeFile(path.join(web, 'microfrontends.json'), '{ "applications": {} }')
      const withConfig = await key()
      expect(withConfig).not.toBe(before)
      await writeFile(path.join(web, 'microfrontends.json'), '{ "applications": { "web": {} } }')
      const edited = await key()
      expect(edited).not.toBe(withConfig)
      // `.jsonc` is the second name Turbo tries.
      await rm(path.join(web, 'microfrontends.json'))
      await writeFile(path.join(web, 'microfrontends.jsonc'), '// routes\n{ "applications": {} }')
      const jsonc = await key()
      expect(jsonc).not.toBe(before)
      await writeFile(path.join(web, 'microfrontends.jsonc'), '{ "applications": { "a": {} } }')
      expect(await key()).not.toBe(jsonc)
      // A child's config names its parent; Turbo keys it into no global.
      await rm(path.join(web, 'microfrontends.jsonc'))
      await writeFile(path.join(web, 'microfrontends.json'), '{ "partOf": "web" }')
      expect(await key()).toBe(before)
      // VC_MICROFRONTENDS_CONFIG_FILE_NAME names the one file Turbo reads.
      await rm(path.join(web, 'microfrontends.json'))
      await writeFile(path.join(web, 'mfe.json'), '{ "applications": {} }')
      expect(await key()).toBe(before)
      process.env['VC_MICROFRONTENDS_CONFIG_FILE_NAME'] = 'mfe.json'
      try {
        expect(await key()).not.toBe(before)
      } finally {
        delete process.env['VC_MICROFRONTENDS_CONFIG_FILE_NAME']
      }
    },
    TIMEOUT,
  )
})

// with-nestjs: the root dev-depends on `@repo/eslint-config`, and Turbo
// hashes the files of every package the root depends on into its global
// hash. `api#lint` (`lint: {}`, no edge) lints with those rules; unread,
// an edit to them replayed every lint from the cache.
describe("the root's workspace dependencies", () => {
  it(
    'key every task, as Turbo’s global hash does, transitively',
    async () => {
      await pkg('rules', { build: 'echo rules' })
      await writeFile(
        path.join(root, 'packages', 'lib', 'package.json'),
        JSON.stringify({ name: 'lib', version: '1.0.0', dependencies: { rules: 'workspace:*' } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const key = async () => {
        const plan = await planRun({ cwd: root, tasks: ['app#test'], log: silent() })
        return plan.tasks.find((t) => t.node.id === 'app#test')!.hash
      }
      const edit = (n: number) =>
        writeFile(path.join(root, 'packages', 'rules', 'src', 'index.js'), `// ${n}\n`)
      // Control: no root edge, so `app#test` (no dependsOn) keys nothing of rules.
      const before = await key()
      await edit(1)
      expect(await key()).toBe(before)
      // The root reaches rules through lib; its manifest is the only edit.
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true, devDependencies: { lib: 'workspace:*' } }),
      )
      const reached = await key()
      await edit(2)
      expect(await key()).not.toBe(reached)
    },
    TIMEOUT,
  )

  it(
    'key every task on a dependency whose dir name holds a brace',
    async () => {
      const dir = path.join(root, 'packages', 'r{x,y}')
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'rules' }))
      await writeFile(path.join(dir, 'src', 'index.js'), '// 0\n')
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'ws', private: true, devDependencies: { rules: 'workspace:*' } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const key = async () => {
        const plan = await planRun({ cwd: root, tasks: ['app#test'], log: silent() })
        return plan.tasks.find((t) => t.node.id === 'app#test')!.hash
      }
      const before = await key()
      expect(before).not.toBe('')
      await writeFile(path.join(dir, 'src', 'index.js'), '// 1\n')
      expect(await key()).not.toBe(before)
    },
    TIMEOUT,
  )
})

// Turbo runs a script through the package manager (`pnpm run build`), which
// sets `npm_package_name`, `npm_package_version` and `npm_lifecycle_event`;
// vx runs the body itself, so `echo $npm_package_version` printed nothing
// and a config reading `process.env.npm_package_version` built `undefined`.
describe('the npm_* variables a package manager sets', () => {
  it(
    'reach a script that names them, the event only where no hook is folded in',
    async () => {
      await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { v: {}, w: {} } }))
      await writeFile(
        path.join(root, 'packages', 'lib', 'package.json'),
        JSON.stringify({
          name: 'lib',
          version: '1.2.3',
          scripts: {
            v: 'echo "$npm_package_name ${npm_package_version} $npm_lifecycle_event" > v.txt',
            w: 'echo "$npm_package_version $npm_lifecycle_event" > w.txt',
            prew: 'true',
          },
        }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      const result = await run({
        cwd: root,
        tasks: ['lib#v', 'lib#w'],
        log: silent(),
        handleSignals: false,
      })
      expect(result.ok).toBe(true)
      const lib = path.join(root, 'packages', 'lib')
      expect(await Bun.file(path.join(lib, 'v.txt')).text()).toBe('lib 1.2.3 v\n')
      expect(await Bun.file(path.join(lib, 'w.txt')).text()).toBe('1.2.3 \n')
    },
    TIMEOUT,
  )
})

// Turbo passes `BUILTIN_PASS_THROUGH_ENV` (TZ, VERCEL_*, GITHUB_*, …) to
// every task and hashes `DEFAULT_ENV_VARS` into every key
// (crates/turborepo-env). Under turbo() the task ran without TZ, and a
// build for VERCEL_TARGET_ENV=preview was a hit for production.
describe("Turbo's builtin env under turbo()", () => {
  const NAMES = ['TZ', 'VERCEL_URL', 'GITHUB_SHA', 'VERCEL_TARGET_ENV', 'UNLISTED_VAR']
  const saved = new Map(NAMES.map((n) => [n, process.env[n]]))
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n]
      else process.env[n] = v
    }
  })
  it(
    'reaches the task; a default re-keys it, a pass-through one does not',
    async () => {
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { e: { outputs: ['dist/**'] } } }),
      )
      await writeFile(
        path.join(root, 'packages', 'lib', 'package.json'),
        JSON.stringify({
          name: 'lib',
          scripts: {
            e: 'mkdir -p dist && echo "$TZ|$VERCEL_URL|$GITHUB_SHA|$VERCEL_TARGET_ENV|$UNLISTED_VAR" > dist/e.txt',
          },
        }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
      Object.assign(process.env, {
        TZ: 'Asia/Tokyo',
        VERCEL_URL: 'x.vercel.app',
        GITHUB_SHA: 'abc',
        VERCEL_TARGET_ENV: 'preview',
        UNLISTED_VAR: 'no',
      })
      const go = async () =>
        (await run({ cwd: root, tasks: ['lib#e'], log: silent(), handleSignals: false }))
          .outcomes[0]!.status
      expect(await go()).toBe('success')
      expect(await Bun.file(path.join(root, 'packages', 'lib', 'dist', 'e.txt')).text()).toBe(
        // A builtin wildcard family (VERCEL_*, GITHUB_*) is not matched
        // against the run's names: the list is keyed, and must key alike
        // on every machine and in the written configs.
        'Asia/Tokyo|||preview|\n',
      )
      process.env['TZ'] = 'UTC'
      expect(await go()).toBe('cache-hit')
      process.env['VERCEL_TARGET_ENV'] = 'production'
      expect(await go()).toBe('success')
    },
    TIMEOUT,
  )
})
