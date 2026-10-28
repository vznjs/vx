// `prepareRun` — the shared setup EVERY `run()` and `planRun()` flows through.
//
// It was reached by three suites only incidentally (a fixture step in
// local-shortcircuit, one `hasRemoteLayer` assertion in orchestrator-remote, a
// timing guard in prepare-perf), while owning rules whose violation is SILENT:
// a project that quietly fails to load, a cache policy that means nothing
// because there is no remote behind it, an empty-run reason both callers branch
// on. THREE separately-recorded defects route through this file — the
// `pkg#task` closure hole, the `hasRemoteLayer` identity test, and the
// unclamped policy in `planRun` — which is the argument for pinning its rules
// rather than trusting the e2e that merely exercises them.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { Cache, type RemoteCacheLayer } from '../src/cache/index.js'
import type { ProjectConfig } from '../src/config.js'
import type { Logger } from '../src/report/index.js'
import { prepareRun as prepareFromLock } from '../src/orchestrator/index.js'
import { lock, prepareRun } from './helpers/orchestrator.js'
import { pluginSource, writeEdges } from './helpers/plugin.js'
import { UserError } from '../src/util/index.js'

const TIMEOUT = 30_000

let root: string
const status: string[] = []
const log: Logger = {
  status: (l) => status.push(l),
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-prep-'))
  status.length = 0
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  )
  for (const k of Object.keys(edgeMap)) delete edgeMap[k]
  await writeEdges(root)
  // Input enumeration is git-backed, so discovery needs a real repo.
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
})

// A row that reads `nodes` alone leaves its cache open. Closing twice is safe.
const opened: Array<Awaited<ReturnType<typeof prepareRun>>> = []

afterEach(async () => {
  for (const p of opened.splice(0)) p.cache.close()
  await rm(root, { recursive: true, force: true })
})

/** The workspace's project edges so far, by name. */
const edgeMap: Record<string, string[]> = {}

/** A package with a vx.config.mjs; `deps` become its edges in the workspace file. */
async function pkg(name: string, config: string, deps: readonly string[] = []): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'a.ts'), `// ${name}\n`)
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  if (deps.length > 0) {
    edgeMap[name] = [...deps]
    await writeEdges(root, edgeMap)
  }
}

/** A task whose dependsOn is exactly `deps`. */
function task(name: string, deps: readonly string[] = []): string {
  const on = deps.length > 0 ? `, dependsOn: ${JSON.stringify(deps)}` : ''
  return `${name}: { exec: { command: 'echo ${name}' }${on} }`
}

function cfg(...tasks: string[]): string {
  return `export default { tasks: { ${tasks.join(', ')} } }`
}

/**
 * Locks the workspace, then edits the locked configs, by package name: a
 * lock `vx lock` would not write, read by `prepare({ locked: true })` as is.
 */
async function editLock(edit: (configs: Record<string, ProjectConfig>) => void): Promise<void> {
  await lock(root)
  const file = path.join(root, '.vx', 'projects.lock.json')
  const held = (await Bun.file(file).json()) as {
    projects: Record<string, { config: ProjectConfig }>
  }
  edit(
    Object.fromEntries(
      Object.entries(held.projects).map(([dir, e]) => [path.posix.basename(dir), e.config]),
    ),
  )
  await Bun.write(file, JSON.stringify(held))
}

/** Locks the workspace, then deletes `name`'s config file: a run that reads it refuses. */
async function goneAfterLock(name: string): Promise<void> {
  await lock(root)
  await rm(path.join(root, 'packages', name, 'vx.config.mjs'))
}

/** What a run says when a config it reads is gone since the lock. */
const gone = (name: string): string =>
  `.vx/projects.lock.json locks packages/${name} ("${name}"), but its vx.config.mjs is gone — run \`vx lock\``

/**
 * NB `prepareRun` takes an EXPLICIT project scope — resolving cwd to "the
 * project that contains it" is the CLI's job (`cli/run.ts`), not this
 * function's. Passing only `cwd` therefore selects the WHOLE workspace, which
 * is why every scoping test below names `projects`.
 */
async function prepare(
  opts: {
    tasks?: string[]
    cwd?: string
    projects?: string[]
    excludeDependencies?: 'all' | string[]
    /** Read the lock as it is, instead of locking first. */
    locked?: boolean
  } = {},
): Promise<Awaited<ReturnType<typeof prepareRun>>> {
  const p = await (opts.locked === true ? prepareFromLock : prepareRun)(
    {
      cwd: opts.cwd ?? root,
      tasks: opts.tasks ?? ['build'],
      concurrency: 1,
      ...(opts.projects !== undefined ? { projects: opts.projects } : {}),
      ...(opts.excludeDependencies !== undefined
        ? { excludeDependencies: opts.excludeDependencies }
        : {}),
    },
    log,
  )
  opened.push(p)
  return p
}

describe('scoped config loading reaches every project a run can need', () => {
  it(
    'follows a `pkg#task` dep the PACKAGE graph cannot reach',
    async () => {
      // The MED-HIGH defect this fixpoint exists for. Scoped loading used to be
      // `seeds ∪ transitiveDeps(seeds)`, justified by "frontier `^task` expansion
      // never escapes the closure" — true for `^task`, FALSE for `pkg#task`,
      // which ignores the package graph BY DESIGN. `codegen` is not a dependency
      // of `app` in any package.json, so nothing but this rule pulls it in, and
      // without it the user got "no such project or task is declared" about a
      // project plainly present on disk.
      await pkg('app', cfg(task('build', ['codegen#gen'])))
      await pkg('codegen', cfg(task('gen')))

      const p = await prepare({ projects: ['app'] })
      expect([...p.nodes.keys()].sort()).toEqual(['app#build', 'codegen#gen'])
      expect(p.empty).toBeNull()
    },
    TIMEOUT,
  )

  it(
    'follows a cross dep discovered in a LATER round',
    async () => {
      // The reason it is a fixpoint rather than one extra pass: a config pulled
      // in by a cross edge may declare cross edges of its own. Two hops from the
      // seed, so a single fix-up round finds `b` and stops before `c`.
      await pkg('app', cfg(task('build', ['b#gen'])))
      await pkg('b', cfg(task('gen', ['c#emit'])))
      await pkg('c', cfg(task('emit')))

      const p = await prepare({ projects: ['app'] })
      expect([...p.nodes.keys()].sort()).toEqual(['app#build', 'b#gen', 'c#emit'])
    },
    TIMEOUT,
  )

  it(
    'pulls a cross target’s own PACKAGE closure, not just the target',
    async () => {
      // `considerWithDeps`, not `consider`: the cross target's `^build` edges
      // resolve against its npm deps, so loading it alone would leave those
      // configs unloaded and the frontier walk unable to see them.
      await pkg('app', cfg(task('build', ['tool#bundle'])))
      await pkg('tool', cfg(task('bundle', ['^build'])), ['lib'])
      await pkg('lib', cfg(task('build')))

      const p = await prepare({ projects: ['app'] })
      expect([...p.nodes.keys()].sort()).toEqual(['app#build', 'lib#build', 'tool#bundle'])
    },
    TIMEOUT,
  )

  it(
    'a `pkg#task` edge is not a package edge: `^build` does not follow it',
    async () => {
      // `^name` walks the package graph the run builds BEFORE configs load,
      // so a task edge on another task cannot widen it. Folding task edges
      // in would move keys and can close cycles; selection (`--filter`,
      // `--affected`) and the dependency rules do read them.
      await pkg('x', cfg(task('build', ['^build']), task('e2e', ['y#build'])))
      await pkg('y', cfg(task('build')))

      const p = await prepare({ projects: ['x'] })
      expect([...p.nodes.keys()].sort()).toEqual(['x#build'])
    },
    TIMEOUT,
  )

  it(
    'a cross dep naming a project that does not exist is inert',
    async () => {
      // `consider` marks the name seen but only queues it when discovery found a
      // meta for it, so a typo'd or since-deleted project cannot crash the load.
      // The graph builder is what reports it, naming the offending task.
      await pkg('app', cfg(task('build', ['ghost#gen'])))
      await expect(prepare({ projects: ['app'] })).rejects.toThrow()
    },
    TIMEOUT,
  )

  it(
    'when EVERY spec is anchored, the anchors alone are the scope',
    async () => {
      // A real optimisation rule, not an accident: with no explicit scope, BARE
      // task names fan out across the workspace, so every config must be
      // read from the lock. When every requested spec is `pkg#task`, the anchors
      // are the scope and nothing else needs reading — which is what keeps
      // `vx run a#build` from paying for a 1000-package config load.
      //
      // Asserted through a sibling whose config is gone since the lock, because the
      // observable is which configs get READ, and `nodes` cannot see it:
      // `expandRequested` resolves an anchored spec to the same one node either
      // way, so a test that reads `nodes` passes whether or not the optimisation
      // exists. (Confirmed — it was the first version of this test, and the
      // mutation that seeds every project survived it.)
      await pkg('app', cfg(task('build')))
      await pkg('other', cfg(task('build')))
      await goneAfterLock('other')

      const anchoredOnly = await prepare({ tasks: ['app#build'], locked: true })
      expect([...anchoredOnly.nodes.keys()]).toEqual(['app#build'])

      // The control: ONE bare name beside the anchor re-opens the fan-out, so
      // the rule is about the whole spec set rather than per-entry — and the
      // missing file is now in scope and reported.
      await expect(prepare({ tasks: ['app#build', 'build'], locked: true })).rejects.toThrow(
        gone('other'),
      )
    },
    TIMEOUT,
  )

  it(
    'a BROKEN config anywhere fails the lock, so no run starts, scoped or not',
    async () => {
      // `vx lock` evaluates every config and writes nothing when one fails, and
      // a run reads configs only from the lock (2026-10-14): a broken
      // config out of a run's scope stops the run too, until it is fixed.
      await pkg('app', cfg(task('build')))
      await pkg('broken', 'export default { tasks: 42 }')

      await expect(lock(root)).rejects.toThrow(
        `✗ vx lock  lock not written\n\n  ${path.join(root, 'packages', 'broken', 'vx.config.mjs')}: ` +
          '`tasks` must be an object keyed by task name',
      )
      await expect(prepare({ projects: ['app'], locked: true })).rejects.toThrow(
        'no lock: run `vx lock`',
      )
    },
    TIMEOUT,
  )

  it(
    'counts every config-bearing project, in scope or not',
    async () => {
      // `workspaceProjectCount` feeds the footer's `N in run · N total` bar, so
      // it must describe the WORKSPACE while `nodes` describes the run. Deriving
      // it from the loaded set would make the bar read 1-of-1 on every scoped run.
      await pkg('app', cfg(task('build')))
      await pkg('other', cfg(task('build')))
      await pkg('third', cfg(task('build')))

      const p = await prepare({ projects: ['app'] })
      expect([...p.nodes.keys()]).toEqual(['app#build'])
      expect(p.workspaceProjectCount).toBe(3)
    },
    TIMEOUT,
  )

  it(
    'fences an out-of-scope NESTED project off its parent’s globs',
    async () => {
      // Boundary geometry is computed over every config-bearing project, loaded
      // or not — a nested project the run never loads must still keep its files
      // out of its parent's input set, or the parent's key silently folds them.
      // The nested project must be DISCOVERED to fence anything, and
      // `packages/*` does not match `packages/app/inner` — so this layout needs
      // a glob that reaches it. Widening the globs is the fixture, not the
      // subject: the subject is that a project the run never LOADS still
      // contributes its boundary.
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*', 'packages/*/*'] }),
      )
      await writeFile(
        path.join(root, 'pnpm-workspace.yaml'),
        'packages:\n  - "packages/*"\n  - "packages/*/*"\n',
      )
      await pkg('app', cfg(task('build')))
      const nested = path.join(root, 'packages', 'app', 'inner')
      await mkdir(nested, { recursive: true })
      await writeFile(
        path.join(nested, 'package.json'),
        JSON.stringify({ name: 'inner', version: '1.0.0' }),
      )
      await writeFile(path.join(nested, 'vx.config.mjs'), cfg(task('build')))

      const p = await prepare({ projects: ['app'] })
      // `inner` is NOT in the run…
      expect([...p.nodes.keys()]).toEqual(['app#build'])
      // …and its directory is still fenced out of app's globs.
      expect(p.nestedDirsByProject.get('app')).toEqual([nested])
    },
    TIMEOUT,
  )
})

// nx#32779: a `^name` no project in the WHOLE workspace declares is refused.
// A scoped run loads only its closure, so the builder cannot see the whole
// workspace there; prepareRun loads the rest only when a `^name` has no
// holder and nothing loaded declares it, and refuses only if the rest does
// not declare it either.
describe('a ^name no project declares is refused in a scoped run too', () => {
  const refusal = async (opts: Parameters<typeof prepare>[0]): Promise<unknown> => {
    try {
      await prepare(opts)
    } catch (err) {
      return err
    }
    return undefined
  }
  /**
   * `vx lock` refuses the typo, so a run meets it only in a lock edited by
   * hand: app's `typo` is locked without it, then given it.
   */
  const typoLocked = async (): Promise<void> => {
    await pkg('app', cfg(task('typo')), ['cart'])
    await editLock((projects) => {
      projects['app']!.tasks!['typo']!.dependsOn = ['^biuld']
    })
  }
  /** Web's locked entry without `pack`: a run that reads it finds no declarer. */
  const webWithoutPack = (): Promise<void> =>
    editLock((projects) => {
      delete projects['web']!.tasks!['pack']
    })

  it(
    'refuses it when the run loads only part of the workspace',
    async () => {
      await pkg('app', cfg(task('typo', ['^biuld'])), ['cart'])
      await pkg('cart', cfg(task('build')))
      await pkg('web', cfg(task('build')))

      await expect(lock(root)).rejects.toThrow(
        '✗ vx lock  lock not written\n\n  app#typo: dependsOn ^biuld but no project in the workspace declares biuld\n\n  fix  ^build',
      )
      await typoLocked()
      const err = await refusal({ tasks: ['app#typo'], locked: true })
      expect(err).toBeInstanceOf(UserError)
      expect((err as Error).message).toBe(
        'app#typo: dependsOn ^biuld but no project in the workspace declares biuld. Did you mean ^build?',
      )
    },
    TIMEOUT,
  )

  // The graph is built whole whatever `--exclude-dependencies` says (a
  // dropped edge is still keyed, excluded-keys.ts), so a typo is refused
  // under the flag as in a full run: whether a config is valid does not
  // depend on the selection, even when the flag names the typo itself.
  it(
    'refuses it under --exclude-dependencies too, scoped or not',
    async () => {
      await pkg('app', cfg(task('typo', ['^biuld'])), ['cart'])
      await pkg('cart', cfg(task('build')))
      await pkg('web', cfg(task('build')))
      await typoLocked()

      const messages: unknown[] = []
      for (const tasks of [['app#typo'], ['typo']]) {
        for (const excludeDependencies of ['all', ['biuld'], ['build']] as const) {
          const err = await refusal({
            tasks,
            locked: true,
            excludeDependencies: excludeDependencies === 'all' ? 'all' : [...excludeDependencies],
          })
          messages.push(err instanceof UserError ? err.message : err)
        }
      }
      expect(messages).toEqual(
        Array(6).fill(
          'app#typo: dependsOn ^biuld but no project in the workspace declares biuld. Did you mean ^build?',
        ),
      )
    },
    TIMEOUT,
  )

  it(
    'plans a ^name only a project outside the loaded closure declares',
    async () => {
      // `pack`, not `build`: every project has a build (the default).
      // app → cart, neither declares pack; web does and is nobody's dep, so
      // its entry is read only to prove the name is not a typo.
      await pkg('app', cfg(task('test', ['^pack'])), ['cart'])
      await pkg('cart', cfg(task('lint')))
      await pkg('web', cfg(task('pack')))

      const p = await prepare({ tasks: ['app#test'] })
      expect([...p.nodes.keys()]).toEqual(['app#test'])
      expect(p.nodes.get('app#test')!.deps).toEqual([])
      // Web's entry is what proved it: locked without pack, the name is refused.
      await webWithoutPack()
      const err = await refusal({ tasks: ['app#test'], locked: true })
      expect(err).toBeInstanceOf(UserError)
      expect((err as Error).message).toBe(
        'app#test: dependsOn ^pack but no project in the workspace declares pack',
      )
    },
    TIMEOUT,
  )

  it(
    'loads nothing more when a loaded project declares the name',
    async () => {
      // The control for the row above: cart declares pack, so nothing is
      // left to prove and web's entry is never read — locked without pack,
      // it refuses nothing.
      await pkg('app', cfg(task('test', ['^pack'])), ['cart'])
      await pkg('cart', cfg(task('pack')))
      await pkg('web', cfg(task('pack')))
      await webWithoutPack()

      const p = await prepare({ tasks: ['app#test'], locked: true })
      expect([...p.nodes.keys()].sort()).toEqual(['app#test', 'cart#pack'])
      expect(await Bun.file(path.join(root, 'web.evaluated')).exists()).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'an out-of-scope config gone since the lock leaves the name unjudged, not the run failed',
    async () => {
      // Proving the typo needs every config; one gone since the lock cannot
      // fail a scoped run (the anchored row above this describe), so the
      // name is let through. Other's pack is what let `vx lock` write it.
      await pkg('app', cfg(task('test', ['^pack'])), ['cart'])
      await pkg('cart', cfg(task('lint')))
      await pkg('other', cfg(task('pack')))
      await goneAfterLock('other')

      const p = await prepare({ tasks: ['app#test'], locked: true })
      expect([...p.nodes.keys()]).toEqual(['app#test'])
    },
    TIMEOUT,
  )
})

// X-182: the whole-workspace check ran only when fewer projects were loaded
// than have configs. `cart` has no config but counts as loaded, so app's
// closure (app, cart) matched the configured count (app, web), web was never
// asked, and a name only web declares was refused as a typo.
describe('a config-less project in the closure does not hide a declarer outside it', () => {
  const bare = async (name: string): Promise<void> => {
    const dir = path.join(root, 'packages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  const outcome = async (opts: Parameters<typeof prepare>[0]): Promise<string[] | string> => {
    try {
      return [...(await prepare(opts)).nodes.keys()].sort()
    } catch (err) {
      return err instanceof UserError ? err.message : String(err)
    }
  }

  it(
    'a ^name and an --exclude-dependencies name only that project declares',
    async () => {
      await pkg('app', cfg(task('test', ['^pack']), task('lint')), ['cart'])
      await bare('cart')
      await pkg('web', cfg(task('pack')))

      expect({
        dep: await outcome({ tasks: ['app#test'] }),
        exclude: await outcome({ tasks: ['app#lint'], excludeDependencies: ['pack'] }),
        // Control: a name nobody declares is still refused.
        depTypo: await outcome({ tasks: ['app#lint'], excludeDependencies: ['pakc'] }),
      }).toEqual({
        dep: ['app#test'],
        exclude: ['app#lint'],
        depTypo: '--exclude-dependencies names a task no project declares: pakc.',
      })
    },
    TIMEOUT,
  )
})

// The builder takes a 50,000-deep chain on its own stack (nx#28788, item
// 737); `--exclude-dependencies` then keys the whole dropped chain, and
// that walk must not recurse once per edge either.
describe('--exclude-dependencies keys a 50,000-deep dropped chain', () => {
  it(
    'without overflowing the call stack',
    async () => {
      const DEPTH = 50_000
      const tasks: string[] = []
      for (let i = 0; i < DEPTH; i++) {
        tasks.push(task(`t${i}`, i + 1 < DEPTH ? [`t${i + 1}`] : []))
      }
      await pkg('app', cfg(...tasks))

      const p = await prepare({ tasks: ['app#t0'], excludeDependencies: 'all' })
      const excluded = p.nodes.get('app#t0')!.excludedUpstream!
      expect([[...p.nodes.keys()], excluded.map((o) => o.node.id)]).toEqual([
        ['app#t0'],
        ['app#t1'],
      ])
      expect(excluded[0]!.hash).toMatch(/^[0-9a-f]{16,}$/)
    },
    TIMEOUT * 4,
  )
})

describe('the empty-run reason both callers branch on', () => {
  it(
    'is null when the run is ready',
    async () => {
      await pkg('app', cfg(task('build')))
      const p = await prepare()
      expect(p.empty).toBeNull()
      expect(p.nodes.size).toBeGreaterThan(0)
    },
    TIMEOUT,
  )

  it(
    "is 'no-tasks-declared' when nothing matched, and NAMES the unresolved ask",
    async () => {
      // The two halves are separate and both load-bearing: `empty` is why the run
      // stops, `unresolvedTasks` is what to tell the user. A run that reports the
      // first without the second exits non-zero saying nothing actionable — the
      // CI footgun the 2026-07-26 wave fixed for the multi-task case.
      await pkg('app', cfg(task('build')))
      const p = await prepare({ tasks: ['totallybogus'] })
      expect(p.empty).toBe('no-tasks-declared')
      expect(p.nodes.size).toBe(0)
      expect(p.unresolvedTasks).toEqual(['totallybogus'])
    },
    TIMEOUT,
  )

  it(
    'reports a typo BESIDE a good task, rather than running the remainder silently',
    async () => {
      // Exactly the shape that used to go green: the guard fired only when the
      // ENTIRE set resolved to zero, so a CI job running `vx run build typo`
      // succeeded the day someone renamed the second task.
      await pkg('app', cfg(task('build')))
      const p = await prepare({ tasks: ['build', 'totallybogus'] })
      expect(p.unresolvedTasks).toEqual(['totallybogus'])
      // `empty` stays null — work DID resolve. The caller must consult
      // `unresolvedTasks` too, which is why they are separate fields.
      expect(p.empty).toBeNull()
      expect([...p.nodes.keys()]).toEqual(['app#build'])
    },
    TIMEOUT,
  )

  it(
    'an EMPTY candidate scope is "nothing selected", never a typo report',
    async () => {
      // The distinction that makes the guard above safe to have: a filter that
      // selects no projects is not a misspelled task, and reporting one would
      // red every correctly-scoped no-op run.
      await pkg('app', cfg(task('build')))
      const p = await prepare({ projects: [] })
      expect(p.unresolvedTasks).toEqual([])
      expect(p.empty).toBe('no-tasks-declared')
    },
    TIMEOUT,
  )

  it(
    'still returns a usable cache handle on the empty path',
    async () => {
      // The empty return is a full PreparedRun on purpose: both callers use one
      // try/finally that closes the cache, so an early return missing `cache`
      // would leak a SQLite handle on every typo'd invocation.
      await pkg('app', cfg(task('build')))
      const p = await prepare({ tasks: ['totallybogus'] })
      expect(p.cache).toBeDefined()
      expect(p.localCache).toBeInstanceOf(Cache)
      expect(p.fingerprintWatch.names).toEqual([])
      p.cache.close()
    },
    TIMEOUT,
  )
})

describe('hasRemoteLayer asks the layer instead of comparing handles', () => {
  it(
    'is false for the bare local cache',
    async () => {
      await pkg('app', cfg(task('build')))
      const p = await prepare()
      expect(p.hasRemoteLayer).toBe(false)
      p.cache.close()
    },
    TIMEOUT,
  )

  it(
    'is true when a remote layer is injected',
    async () => {
      await pkg('app', cfg(task('build')))
      const remote: RemoteCacheLayer = {
        has: async () => null,
        get: async () => null,
        put: async () => undefined,
      }
      const p = await prepareRun(
        { cwd: root, tasks: ['build'], concurrency: 1, remoteCache: remote },
        log,
      )
      expect(p.hasRemoteLayer).toBe(true)
      p.cache.close()
    },
    TIMEOUT,
  )

  it(
    "is true when a plugin's cache hook returns a remote",
    async () => {
      await pkg('app', cfg(task('build')))
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource([
          pluginSource(
            'org/remote',
            `{ cache: () => ({ has: async () => null, get: async () => null, put: async () => {} }) }`,
          ),
        ]),
      )
      const p = await prepare()
      expect(p.hasRemoteLayer).toBe(true)
      p.cache.close()
    },
    TIMEOUT,
  )

  it(
    'is false when every cache plugin declines',
    async () => {
      await pkg('app', cfg(task('build')))
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource([pluginSource('org/declines', `{ cache: () => undefined }`)]),
      )
      const p = await prepare()
      expect(p.cache).toBe(p.localCache)
      expect(p.hasRemoteLayer).toBe(false)
      p.cache.close()
    },
    TIMEOUT,
  )
})

describe('a refused cache plugin leaks nothing', () => {
  it(
    'the local handle opened for the config cache is closed when the cache hook is refused',
    async () => {
      await pkg('app', cfg(task('build')))
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource([pluginSource('org/junk', `{ cache: () => ({ nope: true }) }`)]),
      )
      await lock(root)
      const closes = spyOn(Cache.prototype, 'close')
      try {
        await expect(prepare({ locked: true })).rejects.toThrow(
          "plugin 'org/junk' returned from cache something that is not a remote cache layer",
        )
        // The one handle prepare opened, closed once on the way out — the
        // config cache's `open` happens before the plugin is consulted.
        expect(closes).toHaveBeenCalledTimes(1)
      } finally {
        closes.mockRestore()
      }
    },
    TIMEOUT,
  )
})

describe('a broken config leaks nothing either', () => {
  it(
    'the local handle is closed when a project config fails to load, not only when a cache plugin is refused',
    async () => {
      // The twin of the row above, thirty lines earlier in `prepare.ts` and
      // with the same one-line body and the same comment explaining it. The
      // cache-plugin copy has a row named for it; this one had none, so the
      // `localCache.close()` in the config catch could be deleted and the
      // whole suite stayed green.
      //
      // Both matter for the same reason: the cache is opened BEFORE the
      // configs load. A throw between the open and the return strands an open SQLite handle
      // for a process that keeps running — `vx watch`, an editor plugin, a
      // daemon — and the next open of the same file meets a busy lock.
      await pkg('app', cfg(task('build')))
      await goneAfterLock('app')
      const closes = spyOn(Cache.prototype, 'close')
      try {
        await expect(prepare({ locked: true })).rejects.toThrow(gone('app'))
        expect(closes).toHaveBeenCalledTimes(1)
      } finally {
        closes.mockRestore()
      }
    },
    TIMEOUT,
  )
})

describe('the cache handle honours the resolved policy and dir', () => {
  it(
    '--cache-dir wins over the .vx/cache default',
    async () => {
      await pkg('app', cfg(task('build')))
      const p = await prepareRun(
        { cwd: root, tasks: ['build'], concurrency: 1, cacheDir: 'custom-cache' },
        log,
      )
      expect(p.cacheDir).toBe(path.join(root, 'custom-cache'))
      p.cache.close()
    },
    TIMEOUT,
  )

  it(
    'the default lands under the workspace root, not cwd',
    async () => {
      // Resolved against the WORKSPACE root, so running from inside a package
      // shares one cache with a root-level run rather than creating a second.
      await pkg('app', cfg(task('build')))
      const p = await prepare({ cwd: path.join(root, 'packages', 'app'), projects: ['app'] })
      expect(p.cacheDir).toBe(path.join(root, '.vx', 'cache'))
      p.cache.close()
    },
    TIMEOUT,
  )

  it(
    'a read-off policy reaches the local Cache, not just the plan',
    async () => {
      // The policy is applied at CONSTRUCTION, so a `local:` (no r/w) run cannot
      // serve a hit even if one exists — pinning it here rather than through a
      // run keeps the seam visible where the handle is built.
      await pkg('app', cfg(task('build')))
      const p = await prepareRun(
        {
          cwd: root,
          tasks: ['build'],
          concurrency: 1,
          cache: { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false },
        },
        log,
      )
      expect(await p.localCache.get('deadbeefdeadbeef')).toBeNull()
      p.cache.close()
    },
    TIMEOUT,
  )
})

describe('the remote-axis clamp cannot drift between run and planRun', () => {
  it('both call sites derive the policy from the same helper', async () => {
    // A SOURCE assertion because the defect has no runtime shape at one site:
    // `planRun` read the UNCLAMPED policy, so `--dry --cache-policy=local:,remote:rw`
    // with no remote predicted a miss for a run that would store nothing. The
    // 2026-07-27 fix was structural — hoist the clamp so both derive from one
    // helper — and the thing worth guarding is that neither site drifts back to
    // reading `options.cache` directly.
    const src = await Bun.file(
      path.join(import.meta.dir, '..', 'src', 'orchestrator', 'run.ts'),
    ).text()
    const calls = src.match(/effectiveCachePolicy\(/g) ?? []
    // One declaration + one call in run() + one in planRun().
    expect(calls.length).toBe(3)
  })
})
