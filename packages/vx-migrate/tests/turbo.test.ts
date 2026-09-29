// A Turbo repo runs under vx with no vx.config written. Every pin is a real
// `planRun` / `run` over a workspace whose only vx file declares the plugin:
// the migrate suite's Turbo fixture, minus the migration.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger, type ProjectConfig, type ProjectMeta } from '@vzn/vx'
import { turbo } from '../src/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { tamperMapping } from './helpers/tamper-mapping.js'

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
    path.join(root, 'vx.workspace.mjs'),
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
      expect(cache.inputs.files).toEqual(['**/*', '!**/*.md'])
      // globalDependencies and the $TURBO_ROOT$/ input both name the
      // file; the mapper sees both strings and lists it once.
      expect(cache.inputs.workspaceFiles).toEqual(['tsconfig.base.json'])
      expect(cache.inputs.env).toEqual(['GLOBAL_MODE', 'NODE_ENV'])
      expect(cache.outputs.files).toEqual(['dist/**'])
      expect(app.config.exec?.env?.passThrough).toEqual(['GLOBAL_MODE', 'AWS_PROFILE', 'NODE_ENV'])
      expect(app.config.exec?.command).toBe('mkdir -p dist && cat src/gen/api.js > dist/app.js')
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
      const log = silent()
      await planRun({ cwd: root, tasks: ['build', 'test', 'lint'], log })
      const text = log.lines.join('\n')
      expect(text).not.toContain('outputLogs" ("new-only")')
      expect(text).not.toContain('has no vx equivalent')
      expect(text).toContain(
        '[@vzn/vx-migrate] app#test: turbo key "outputLogs" ("hash-only") is a per-run setting in vx — run with --output-logs hash-only',
      )
      expect(text).toContain(
        '[@vzn/vx-migrate] app#lint: turbo key "outputLogs" ("loud") is not a value vx knows — run with --output-logs full|hash-only|errors-only|none',
      )
    },
    TIMEOUT,
  )

  it(
    'every persistent task is one warning per run, not one per task',
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
      const quiet = silent()
      await planRun({ cwd: root, tasks: ['build'], log: quiet })
      expect(quiet.lines.filter((l) => l.includes('persistent'))).toEqual([])
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
      const log = silent()
      await planRun({ cwd: root, tasks: ['build'], log })
      const lines = log.lines.filter((l) => l.includes('persistent'))
      expect(lines).toEqual([
        '[@vzn/vx-migrate] 2 task(s) (dev across 2 package(s)): persistent in turbo.json — vx runs them as persistent tasks that are ready on spawn; add `exec.persistent.readyWhen` in a vx.config to gate dependents on their output',
      ])
    },
    TIMEOUT,
  )

  it(
    'a ^task no package has a script for is no edge, as under turbo',
    async () => {
      // turbo.json may name a task no package runs (`prepack` here): Turbo
      // gives `^prepack` no edges. Passed through, core refuses a `^name`
      // no project declares (nx#32779), so the mapper drops it.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: { build: {}, prepack: {}, test: { dependsOn: ['^build', '^prepack'] } },
        }),
      )
      const plan = await planRun({ cwd: root, tasks: ['test'], log: silent() })
      expect(plan.tasks.map((t) => t.node.id).sort()).toEqual(['app#test', 'lib#build'])
      const test = plan.tasks.find((t) => t.node.id === 'app#test')!.node
      expect(test.deps).toEqual(['lib#build'])
      expect(test.config.dependsOn).toEqual(['^build'])
    },
    TIMEOUT,
  )

  it(
    'a gap shared by many tasks is one warning per run, not written',
    async () => {
      // A nameless root stays no project, so its root task is a note.
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }))
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({
          tasks: { build: { outputs: ['dist/**'], env: ['VERCEL_*'] }, '//#root': {} },
        }),
      )
      const log = silent()
      await planRun({ cwd: root, tasks: ['build'], log })
      const text = log.lines.join('\n')
      // Once for the workspace note, once for the gap — astro's `build`
      // carried one gap in 57 tasks, and a line per task was 57 identical
      // lines before the first frame (2026-09-11).
      expect(text).toContain(
        '[@vzn/vx-migrate] 2 task(s) (build across 2 package(s)): env "VERCEL_*": wildcards are not supported',
      )
      expect(text).not.toContain('app#build: output')
      expect(text).toContain('[@vzn/vx-migrate] note: root task //#root not migrated')
      expect(text.split('root task //#root').length - 1).toBe(1)
      expect(text.split('wildcards are not supported').length - 1).toBe(1)
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
      expect(log.lines.join('\n')).not.toContain('root task')
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
      expect(log.lines.join('\n')).not.toContain('root task')
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
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['app#build'], log })
      expect(plan.tasks.map((t) => t.node.id)).toEqual(['app#build'])
      const text = log.lines.join('\n')
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
          path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts'),
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

describe('output negation', () => {
  it(
    'a negation that carves the package root out of a wildcard output runs the task uncached',
    async () => {
      // medusa: `outputs: ["!node_modules/**", "!src/**", "*/**", ".medusa/**"]`.
      // `*/**` reaches every source dir the negations do not name, and the
      // clean before exec would delete them. Uncached, and the sources
      // survive a real run.
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
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.config.cache).toBeUndefined()
      expect(log.lines.join('\n')).toContain(
        '[@vzn/vx-migrate] 2 task(s) (build across 2 package(s)): output "*/**": a wildcard first segment reaches the sources, which vx cleans before every run — task runs uncached; declare the exact outputs in a vx.config to cache it',
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

  it(
    'a route directory first is a literal, not a wildcard reaching the sources (item 667)',
    async () => {
      // A bracket is literal in a vx task glob, so `[locale]/**` names one
      // directory, and the task stays cached with its negation.
      await writeFile(
        path.join(root, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: ['[locale]/**', '!**/*.map'] } } }),
      )
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.config.cache?.outputs.files).toEqual(['[locale]/**', '!**/*.map'])
      expect(log.lines.join('\n')).not.toContain('reaches the sources')
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
      const lint = await planRun({ cwd: root, tasks: ['lint'], log })
      expect(lint.tasks.map((t) => t.node.id)).toEqual([])
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      expect(app.deps).toEqual([])
      expect(app.config.cache!.inputs.files).toEqual(['**/*'])
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
      const log = silent()
      const plan = await planRun({ cwd: root, tasks: ['build'], log })
      const app = plan.tasks.find((t) => t.node.id === 'app#build')!.node
      const cache = app.config.cache!
      expect(cache.inputs.files).toEqual(['src/**'])
      expect(cache.inputs.workspaceFiles).toEqual([
        'tsconfig.base.json',
        'packages/lib/src/**',
        '!packages/lib/src/**/*.test.ts',
      ])
      expect(cache.outputs.files).toEqual(['dist/**'])
      expect(cache.outputs.workspaceFiles).toEqual(['packages/lib/generated/**'])
      expect(log.lines.join('\n')).toContain(
        'output "../../../elsewhere/**": leaves the workspace — map manually',
      )
    },
    TIMEOUT,
  )
})

describe('the mapping reads the packages core discovered', () => {
  it('maps a package that is in ctx.projects and not on disk — the plugin never walks the workspace itself', async () => {
    const plugin = turbo()
    const ghost = {
      name: 'ghost',
      dir: path.join(root, 'packages', 'ghost'),
      packageJson: { name: 'ghost', version: '1.0.0', scripts: { build: 'echo ghost' } },
      configPath: null,
    } as unknown as ProjectMeta
    const config: ProjectConfig = { tasks: {} }
    await plugin.project!(config, {
      workspaceRoot: root,
      cacheDir: path.join(root, '.vx'),
      warn() {},
      name: ghost.name,
      dir: ghost.dir,
      packageJson: ghost.packageJson as unknown as Readonly<Record<string, unknown>>,
      projects: [ghost],
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
        path.join(root, 'vx.workspace.mjs'),
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
  // An empty turbo.json is not an absent one: it shadows the turbo.jsonc
  // beside it, and Turbo refuses it; keyed alike, a hit ran the old mapping.
  it('an empty turbo.json beside a turbo.jsonc maps afresh, and is refused', async () => {
    const dir = path.join(root, 'packages', 'app')
    await writeFile(path.join(dir, 'turbo.jsonc'), '{ "extends": ["//"], "tasks": {} }')
    await lint()
    await tamperMapping(root, 'turbo')
    await writeFile(path.join(dir, 'turbo.json'), '')
    await expect(lint()).rejects.toThrow('failed to parse packages/app/turbo.json')
  })

  // A hit is the whole mapping: its notes and todos warn as the miss did.
  // Restored as nothing, a cached run dropped every warning.
  it('a hit warns what the miss warned', async () => {
    // A nameless root stays no project, so its root task is a note.
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }))
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        tasks: { ...TURBO_JSON.tasks, lint: { cache: false, interactive: true }, '//#fmt': {} },
      }),
    )
    const warned = async (): Promise<string[]> => {
      const log = silent()
      await planRun({ cwd: root, tasks: ['lint'], log })
      return log.lines
    }
    const miss = await warned()
    await tamperMapping(root, 'turbo')
    expect({
      hasNote: miss.some((l) => l.includes('//#fmt')),
      hasTodo: miss.some((l) => l.includes('interactive')),
    }).toEqual({ hasNote: true, hasTodo: true })
    expect(await warned()).toEqual(miss)
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
