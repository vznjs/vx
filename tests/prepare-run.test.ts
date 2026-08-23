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
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource, writeLocalWorkspace } from './helpers/local-workspace.js'
import { Cache, type RemoteCacheLayer } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { prepareRun } from '../src/orchestrator/index.js'

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
  await writeLocalWorkspace(root)
  // Input enumeration is git-backed, so discovery needs a real repo.
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A package with a vx.config.mjs; `deps` become real package.json deps. */
async function pkg(name: string, config: string, deps: readonly string[] = []): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src', 'a.ts'), `// ${name}\n`)
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      ...(deps.length > 0
        ? { dependencies: Object.fromEntries(deps.map((d) => [d, '1.0.0'])) }
        : {}),
    }),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
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
 * NB `prepareRun` takes an EXPLICIT project scope — resolving cwd to "the
 * project that contains it" is the CLI's job (`cli/run.ts`), not this
 * function's. Passing only `cwd` therefore selects the WHOLE workspace, which
 * is why every scoping test below names `projects`.
 */
async function prepare(
  opts: { tasks?: string[]; cwd?: string; projects?: string[] } = {},
): Promise<Awaited<ReturnType<typeof prepareRun>>> {
  return await prepareRun(
    {
      cwd: opts.cwd ?? root,
      tasks: opts.tasks ?? ['build'],
      concurrency: 1,
      ...(opts.projects !== undefined ? { projects: opts.projects } : {}),
    },
    log,
  )
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
      // evaluated. When every requested spec is `pkg#task`, the anchors are the
      // scope and nothing else needs evaluating — which is what keeps
      // `vx run a#build` from paying for a 1000-package config load.
      //
      // Asserted through a BROKEN sibling, because the observable is which
      // configs get EVALUATED, and `nodes` cannot see it: `expandRequested`
      // resolves an anchored spec to the same one node either way, so a test
      // that reads `nodes` passes whether or not the optimisation exists.
      // (Confirmed — it was the first version of this test, and the mutation
      // that seeds every project survived it.)
      await pkg('app', cfg(task('build')))
      await pkg('other', 'export default { tasks: 42 }')

      const anchoredOnly = await prepare({ tasks: ['app#build'] })
      expect([...anchoredOnly.nodes.keys()]).toEqual(['app#build'])

      // The control: ONE bare name beside the anchor re-opens the fan-out, so
      // the rule is about the whole spec set rather than per-entry — and the
      // broken config is now in scope and reported.
      await expect(prepare({ tasks: ['app#build', 'build'] })).rejects.toThrow()
    },
    TIMEOUT,
  )

  it(
    'an out-of-scope BROKEN config does not fail a scoped run',
    async () => {
      // Deliberate, and a Turbo-like semantic rather than an accident: scoped
      // loading only evaluates what the run can reach, so a package with a
      // broken config surfaces when it ENTERS scope, not before. Pinned because
      // it is the user-visible consequence of the scoping optimisation, and the
      // obvious "load everything and validate up front" refactor would undo it.
      await pkg('app', cfg(task('build')))
      await pkg('broken', 'export default { tasks: 42 }')

      const p = await prepare({ projects: ['app'] })
      expect([...p.nodes.keys()]).toEqual(['app#build'])
      // …and it IS reported once that project is in scope.
      await expect(prepare({ projects: ['broken'] })).rejects.toThrow()
    },
    TIMEOUT,
  )

  it(
    'counts every config-bearing project, in scope or not',
    async () => {
      // `workspaceProjectCount` feeds the footer's `N affected · N total` bar, so
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
      expect(p.workspaceFingerprint).toMatch(/^[0-9a-f]{16}$/)
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
        has: async () => false,
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
    'a pass-through decorator with NO remote answers false',
    async () => {
      // The HIGH defect, and the discriminating case. `hasRemoteLayer` used to be
      // `cache !== localCache`, which answers a DIFFERENT question — "did the
      // plugin hand back something other than the handle I passed in?" — and an
      // ordinary decorator (a metrics wrapper, a cache-dir redirect) says yes
      // while having no remote at all. That unclamped the remote axes, so a task
      // believing it would be saved cleaned its outputs and, under `--verify`,
      // restored an artifact nothing had written.
      //
      // Driven through the real plugin seam rather than by constructing the field:
      // what matters is that a layer which never DECLARES a remote is not credited
      // with one, however it came to exist.
      await pkg('app', cfg(task('build')))
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{ name: 'passthrough', cache: (ctx) => new Proxy(ctx.localCache, {}) }`,
        ]),
      )
      const p = await prepare()
      // The plugin DID return a different handle…
      expect(p.cache).not.toBe(p.localCache)
      // …and that is precisely not evidence of a remote.
      expect(p.hasRemoteLayer).toBe(false)
      p.cache.close()
    },
    TIMEOUT,
  )

  it(
    'a third-party layer that truthfully declares a remote is believed',
    async () => {
      // The other direction: the marker is an opt-in a real remote layer sets, so
      // a non-LayeredCache implementation is not excluded by construction.
      await pkg('app', cfg(task('build')))
      await writeFile(
        path.join(root, 'vx.workspace.mjs'),
        localWorkspaceSource([
          `{ name: 'declares', cache: (ctx) => {
         const l = Object.create(Object.getPrototypeOf(ctx.localCache))
         Object.assign(l, ctx.localCache)
         l.hasRemote = true
         return l
       } }`,
        ]),
      )
      const p = await prepare()
      expect(p.hasRemoteLayer).toBe(true)
      p.cache.close()
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
    // `planRun` read the UNCLAMPED policy, so `--dry --cache=local:,remote:rw`
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
