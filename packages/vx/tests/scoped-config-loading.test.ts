// Scoped config loading: only configs of in-scope projects and their
// transitive dependency closure are evaluated. On a 1090-package
// repo, `vx run one#task` must not pay 1090 config imports — and a
// broken config in an unrelated package must not fail the run.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import type { Logger } from '../src/orchestrator/index.js'
import { loadProjects, loadResolvedProjects, run } from '../src/orchestrator/index.js'
import { buildPackageGraph, listProjects, loadWorkspace } from '../src/workspace/index.js'
import type { ProjectEntry } from '../src/workspace/index.js'

const TIMEOUT = 30_000
let root: string

const silent = (): Logger => ({
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
})

async function addProject(name: string, config: string, deps: string[] = []): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      ...(deps.length
        ? { dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])) }
        : {}),
    }),
  )
  await writeFile(path.join(dir, 'src', 'in.txt'), 'v1')
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

const GOOD = `export default { tasks: { build: {
  exec: { command: 'echo ok > out.txt' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
} } }`

const BROKEN = `throw new Error('this config must never be evaluated for out-of-scope runs')`

describe('scoped config loading', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-scoped-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await writeLocalWorkspace(root)
    await mkdir(path.join(root, 'packages'), { recursive: true })
    const git = (...a: string[]) => {
      const p = Bun.spawnSync({
        cmd: ['git', '-c', 'commit.gpgsign=false', ...a],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
    }
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'anchored run loads only the target + its dep closure',
    async () => {
      await addProject('lib', GOOD)
      await addProject('app', GOOD, ['lib'])
      await addProject('unrelated', BROKEN)

      // unrelated's config throws on evaluation — the run only
      // succeeds if it was never loaded.
      const r = await run({ cwd: root, tasks: ['app#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['app#build'])
    },
    TIMEOUT,
  )

  it(
    'dep-closure configs ARE loaded (frontier expansion still sees them)',
    async () => {
      await addProject('lib', GOOD)
      await addProject(
        'app',
        `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'echo app > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
        ['lib'],
      )
      const r = await run({ cwd: root, tasks: ['app#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['app#build', 'lib#build'])
    },
    TIMEOUT,
  )

  it(
    'a pkg#task dep loads a project the PACKAGE closure never reaches',
    async () => {
      // `docs` declares no npm dependency on `app`, so `app` is outside
      // `transitiveDeps('docs')`. The cross form deliberately ignores the
      // package graph, so its target's config must still be evaluated.
      await addProject('app', GOOD)
      await addProject(
        'docs',
        `export default { tasks: { build: {
          dependsOn: ['app#build'],
          exec: { command: 'echo docs > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      const r = await run({ cwd: root, tasks: ['docs#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['app#build', 'docs#build'])
    },
    TIMEOUT,
  )

  it(
    'cross-dep loading reaches a fixpoint (a pulled-in config may cross again)',
    async () => {
      await addProject('tools', GOOD)
      await addProject(
        'app',
        `export default { tasks: { build: {
          dependsOn: ['tools#build'],
          exec: { command: 'echo app > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      await addProject(
        'docs',
        `export default { tasks: { build: {
          dependsOn: ['app#build'],
          exec: { command: 'echo docs > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      // Filter scope (not anchored) — the second hop is only reachable if
      // the pre-scan iterates rather than doing a single pass.
      const r = await run({ cwd: root, tasks: ['build'], projects: ['docs'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual([
        'app#build',
        'docs#build',
        'tools#build',
      ])
    },
    TIMEOUT,
  )

  it(
    'a cross-dep target pulls in ITS package closure too',
    async () => {
      // `app` npm-depends on `lib` and declares `^build`. Reaching app via a
      // cross edge must also load lib, or app's frontier finds nothing.
      await addProject('lib', GOOD)
      await addProject(
        'app',
        `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'echo app > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
        ['lib'],
      )
      await addProject(
        'docs',
        `export default { tasks: { build: {
          dependsOn: ['app#build'],
          exec: { command: 'echo docs > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      const r = await run({ cwd: root, tasks: ['docs#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual([
        'app#build',
        'docs#build',
        'lib#build',
      ])
    },
    TIMEOUT,
  )

  it(
    'full-scope runs still surface broken configs',
    async () => {
      await addProject('a', GOOD)
      await addProject('unrelated', BROKEN)
      await expect(run({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /never be evaluated/,
      )
    },
    TIMEOUT,
  )

  it(
    'a STAGED project does not consume another project’s evaluated config',
    async () => {
      // `withFile` skips a project the caller already staged for two
      // reasons, and only one of them is written down. The stated one is
      // cost: no second evaluation, no second `project` stage. The other is
      // ALIGNMENT — the loop below walks the round and reads `loaded[next++]`
      // for each project it did not skip, so an evaluated config that
      // belongs to a staged project would shift every later project onto
      // its neighbour's config. Wrong tasks, wrong commands, wrong cache
      // keys, under a green run.
      //
      // Order matters for the witness: the staged project must come FIRST
      // in the round, so its entry is the one the next project would read.
      await addProject(
        'a-staged',
        "export default { tasks: { alpha: { exec: { command: 'echo a' } } } }\n",
      )
      await addProject(
        'b-fresh',
        "export default { tasks: { beta: { exec: { command: 'echo b' } } } }\n",
      )
      const metas = await listProjects(await loadWorkspace(root))
      const staged = new Map<string, ProjectEntry>([
        [
          'a-staged',
          {
            name: 'a-staged',
            dir: path.join(root, 'packages', 'a-staged'),
            config: { tasks: { alpha: { exec: { command: 'echo staged' } } } },
          },
        ],
      ])
      const loaded = await loadProjects({
        workspaceRoot: root,
        cacheDir: path.join(root, '.vx/cache'),
        plugins: [],
        projectMetas: metas,
        packageGraph: buildPackageGraph([...metas]),
        seeds: 'all',
        closure: false,
        lock: null,
        evalCache: undefined,
        warn: () => {},
        staged,
      })
      // Each project keeps its OWN tasks.
      expect(Object.keys(loaded.projects.get('b-fresh')!.config.tasks ?? {})).toEqual(['beta'])
      expect(Object.keys(loaded.projects.get('a-staged')!.config.tasks ?? {})).toEqual(['alpha'])
      // And the staged entry is taken as given, not re-evaluated: the
      // command is the one the caller staged, not the one on disk.
      expect(loaded.projects.get('a-staged')!.config.tasks!['alpha']!.exec!.command).toBe(
        'echo staged',
      )
    },
    TIMEOUT,
  )

  it(
    'a malformed cross spec is the GRAPH BUILDER’s error, naming the task',
    async () => {
      // Config loading walks `dependsOn` to find `pkg#task` targets whose
      // configs it must pull in, and swallows a spec it cannot parse on
      // purpose: the graph builder reports it, with the offending task's id
      // in front. Rethrowing here would surface the same sentence stripped
      // of the one thing that says WHERE to fix it — and earlier, from a
      // load that has no task to name.
      await addProject(
        'lib',
        `export default { tasks: { build: {
          dependsOn: ['^lib#build'],
          exec: { command: 'echo x' },
        } } }`,
      )
      const r = await run({ cwd: root, tasks: ['build'], log: silent() }).catch(
        (err: unknown) => err,
      )
      const message = r instanceof Error ? r.message : String(r)
      expect(message).toContain('Task lib#build:')
      expect(message).toContain('"^" cannot combine with "pkg#task"')
    },
    TIMEOUT,
  )

  it(
    'a READER sees its scope and nothing else — no closure, no config-less packages',
    async () => {
      // `loadResolvedProjects` is what `vx show`, `vx mcp` and an embedder
      // read. It passes `closure: false` deliberately: a reader asked about
      // one project is answered about that project, where a RUN pulls the
      // dependency closure in because `^task` needs it. And a package that
      // wrote no config declares no tasks unless a `project` plugin fills
      // the stage, so it is not a project here at all.
      await addProject('lib', GOOD)
      await addProject('app', GOOD, ['lib'])
      const bare = path.join(root, 'packages', 'bare')
      await mkdir(bare, { recursive: true })
      await writeFile(path.join(bare, 'package.json'), JSON.stringify({ name: 'bare' }))

      const scoped = await loadResolvedProjects(root, { scope: ['app'] })
      expect([...scoped.keys()]).toEqual(['app'])
      // CONTROL: unscoped, every CONFIGURED project — and still not `bare`.
      const all = await loadResolvedProjects(root)
      expect([...all.keys()].sort()).toEqual(['app', 'lib'])
    },
    TIMEOUT,
  )
})
