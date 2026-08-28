// Two tasks declaring the same output destroy each other's work while the run
// reports success. This is data loss with a green summary, and it is a hazard
// vx CREATED: output ownership is STRICT here — a task's declared outputs are
// wiped before it runs AND before a cache-hit restore, so the tree ends
// byte-identical to the cached artifact. Turbo restores additively and cannot
// hit this, which is why no upstream test surfaces it and why the parity
// research had to reproduce it end to end.
//
// The refusal is at graph build, so it fires before anything executes. It
// changes no cache key — it only rejects a graph that was already deleting
// files.
//
// The detection is deliberately CONSERVATIVE, and the reason is the whole
// design: the caller refuses the run, so a false positive breaks a build that
// works today, which is worse than the defect being caught. Only provable
// overlaps are refused; anything undecidable is allowed through.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildTaskGraph } from '../src/graph/index.js'
import type { ProjectEntry } from '../src/workspace/index.js'
import type { PackageGraph } from '../src/workspace/index.js'
import type { ProjectConfig, TaskConfig } from '../src/config.js'

function task(outputs: string[], wsOutputs?: string[]): TaskConfig {
  return {
    exec: { command: 'build' },
    cache: {
      inputs: { files: [] },
      outputs: { files: outputs, ...(wsOutputs ? { workspaceFiles: wsOutputs } : {}) },
    },
  }
}

/** Same, but the task never materialises its outputs on this machine. */
function remoteOnlyTask(outputs: string[], wsOutputs?: string[]): TaskConfig {
  const t = task(outputs, wsOutputs)
  return { ...t, exec: { ...t.exec!, remote: 'only' } } as TaskConfig
}

/** Build a graph over projects → tasks, requesting every task. */
function graph(projects: Record<string, Record<string, TaskConfig>>): void {
  const entries = new Map<string, ProjectEntry>()
  for (const [name, tasks] of Object.entries(projects)) {
    entries.set(name, {
      name,
      dir: `/w/${name}`,
      configPath: `/w/${name}/vx.config.ts`,
      config: { tasks } as ProjectConfig,
    } as ProjectEntry)
  }
  const pkg = {
    transitiveDeps: () => [],
    directDeps: () => [],
    has: () => false,
  } as unknown as PackageGraph
  buildTaskGraph({
    projects: entries,
    packageGraph: pkg,
    requested: [...entries.values()].flatMap((e) =>
      Object.keys(e.config.tasks ?? {}).map((t) => ({ project: e.name, task: t })),
    ),
  })
}

describe('two tasks cannot claim the same output', () => {
  it('refuses an identical glob declared by two tasks in one project', () => {
    // The common shape: `dist/**` copy-pasted into a second task. Whichever
    // runs second wipes the first's output, and the run stays green.
    expect(() => graph({ app: { build: task(['dist/**']), bundle: task(['dist/**']) } })).toThrow(
      /both declare the output/,
    )
  })

  it('names both tasks and points at the fix', () => {
    // The message is read by someone whose build is now failing on a config
    // that "worked" yesterday, so it has to say why the previous behaviour was
    // not actually working.
    let msg = ''
    try {
      graph({ app: { build: task(['dist/**']), bundle: task(['dist/**']) } })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('app#build')
    expect(msg).toContain('app#bundle')
    expect(msg).toContain('DELETES')
    expect(msg).toContain('cache.outputs.files')
  })

  it('refuses a glob that swallows another task’s literal output', () => {
    // The insidious direction — the two declarations do not look alike at all,
    // but `dist/**` matches `dist/app.js`, so the broad task erases the
    // narrow one.
    expect(() => graph({ app: { build: task(['dist/**']), emit: task(['dist/app.js']) } })).toThrow(
      /both declare the output/,
    )
  })

  it('refuses in either declaration order', () => {
    // The check is pairwise, so it must not depend on which task is visited
    // first — the failure it prevents does not.
    expect(() => graph({ app: { emit: task(['dist/app.js']), build: task(['dist/**']) } })).toThrow(
      /both declare the output/,
    )
  })

  it('refuses a partial-wildcard glob over a matching literal', () => {
    expect(() =>
      graph({ app: { all: task(['dist/vx-*']), one: task(['dist/vx-linux-x64']) } }),
    ).toThrow(/both declare the output/)
  })
})

describe('what must NOT be refused — a false positive breaks a working build', () => {
  it('allows distinct literal outputs in one project', () => {
    // THIS REPO'S OWN SHAPE. `build.bun.linux-x64` … `build.bun.darwin-arm64`
    // all write into `dist/` under distinct literal names. A check that
    // compared each glob's static prefix would collapse them all to `dist`
    // and refuse vx's own release build — which is exactly why the prefix
    // approach was measured and rejected.
    expect(() =>
      graph({
        '@vzn/vx': {
          'build.bun.linux-x64': task(['dist/vx-linux-x64']),
          'build.bun.linux-arm64': task(['dist/vx-linux-arm64']),
          'build.bun.darwin-x64': task(['dist/vx-darwin-x64']),
          'build.bun.darwin-arm64': task(['dist/vx-darwin-arm64']),
        },
      }),
    ).not.toThrow()
  })

  it('allows a glob and a literal it does not match', () => {
    // The precise case that kills the static-prefix approach: `dist/vx-*` and
    // `dist/other.txt` share the prefix `dist` while matching disjoint sets.
    expect(() =>
      graph({ app: { a: task(['dist/vx-*']), b: task(['dist/other.txt']) } }),
    ).not.toThrow()
  })

  it('allows disjoint subdirectory globs', () => {
    expect(() => graph({ app: { a: task(['dist/a/**']), b: task(['dist/b/**']) } })).not.toThrow()
  })

  it('allows two DIFFERENT projects to use the same project-relative path', () => {
    // `outputs.files` is project-relative, so `dist/**` in two projects names
    // two different directories. Refusing this would break essentially every
    // monorepo — nearly all of them build into a per-package `dist`.
    expect(() =>
      graph({ a: { build: task(['dist/**']) }, b: { build: task(['dist/**']) } }),
    ).not.toThrow()
  })

  it('allows two undecidable globs that are not identical', () => {
    // Glob-vs-glob intersection is not decided here. `dist/*.js` and
    // `dist/**/*.js` very likely overlap, but proving it needs a general
    // algorithm, so the check lets them through rather than risk refusing a
    // working config. Pinned so the conservatism is a decision, not an
    // accident — widening this is where a future intersection algorithm goes.
    expect(() =>
      graph({ app: { a: task(['dist/*.js']), b: task(['dist/**/*.js']) } }),
    ).not.toThrow()
  })

  it('allows a task with no declared outputs beside one that has them', () => {
    expect(() => graph({ app: { lint: task([]), build: task(['dist/**']) } })).not.toThrow()
  })

  it('does not compare a task against itself', () => {
    // A single task declaring `dist/**` obviously overlaps its own
    // declaration; only DISTINCT tasks can destroy each other.
    expect(() => graph({ app: { build: task(['dist/**', 'dist/extra.js']) } })).not.toThrow()
  })
})

describe('workspaceFiles outputs ignore project boundaries, so any two tasks can collide', () => {
  it('refuses the same workspace output claimed by tasks in DIFFERENT projects', () => {
    // The asymmetry that matters: `outputs.workspaceFiles` is anchored at the
    // workspace root by design, so unlike `files` it reaches across projects —
    // and two projects writing the same generated file is a realistic shape
    // (shared codegen).
    expect(() =>
      graph({
        a: { gen: task([], ['generated/schema.ts']) },
        b: { gen: task([], ['generated/schema.ts']) },
      }),
    ).toThrow(/cache\.outputs\.workspaceFiles/)
  })

  it('allows distinct workspace outputs across projects', () => {
    expect(() =>
      graph({
        a: { gen: task([], ['generated/a.ts']) },
        b: { gen: task([], ['generated/b.ts']) },
      }),
    ).not.toThrow()
  })

  it('does not confuse the two namespaces', () => {
    // A project-relative `generated/x.ts` and a root-relative one name
    // different files unless the project IS the root, so the two lists are
    // never compared against each other.
    expect(() =>
      graph({
        a: { gen: task(['generated/x.ts']) },
        b: { gen: task([], ['generated/x.ts']) },
      }),
    ).not.toThrow()
  })
})

describe('the check must not cost the graph its linearity', () => {
  it('stays near-linear at 1000 projects x 10 tasks', () => {
    // The first cut of this check compared ALL PAIRS of nodes and filtered by
    // project inside the loop. That is quadratic in the whole graph, and it
    // measured 1614 ms at this shape — on every run, against a ~120 ms warm
    // run. Indexing by project first (and by "declares workspaceFiles" for the
    // boundary-free namespace) took it to ~17 ms, of which ~5 ms is the check.
    //
    // Same failure mode as the scheduler's priority closure, which took 8.5 s
    // on a 1090-package repo before it was rewritten — so this is guarded
    // rather than trusted. The bound is ~30x the measured cost: it separates
    // an indexed pass from an accidental return to all-pairs (which would be
    // seconds here), while staying robust to CI noise.
    const PROJECTS = 1000
    const TASKS = 10
    const projects: Record<string, Record<string, TaskConfig>> = {}
    for (let p = 0; p < PROJECTS; p++) {
      const tasks: Record<string, TaskConfig> = {}
      // Distinct literal outputs — the shape a real monorepo has, and the one
      // that must NOT be flagged.
      for (let t = 0; t < TASKS; t++) tasks[`task${t}`] = task([`dist/out-${t}.js`])
      projects[`p${p}`] = tasks
    }
    let best = Infinity
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now()
      graph(projects)
      best = Math.min(best, performance.now() - t0)
    }
    expect(best).toBeLessThan(600)
  }, 120_000)
})

describe('the data loss itself, end to end', () => {
  it('a second task really does delete the first task’s output', async () => {
    // Proves the refusal is protecting against something real rather than a
    // theory. Runs the actual clean the orchestrator performs before a task
    // executes, and shows the first task's artifact gone.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-collide-'))
    try {
      const { cleanOutputs } = await import('../src/cache/index.js')
      await mkdir(path.join(dir, 'dist'), { recursive: true })
      await writeFile(path.join(dir, 'dist', 'from-build.js'), 'built by app#build')
      expect(await Bun.file(path.join(dir, 'dist', 'from-build.js')).exists()).toBe(true)

      // app#bundle declares the same `dist/**`; vx wipes its declared outputs
      // before running it. app#build's artifact is collateral.
      await cleanOutputs({ projectDir: dir, outputs: ['dist/**'], nestedProjectDirs: [] })

      expect(await Bun.file(path.join(dir, 'dist', 'from-build.js')).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a remote-only task cannot participate in a collision', () => {
  // The hazard is local cleaning — "whichever runs second DELETES the other's
  // output". A `remote: 'only'` task turns off both cache axes in
  // execute-task, so it never probes, restores, cleans or saves on this
  // machine. There is nothing of its on disk to delete and it deletes nothing
  // of anyone's, so the refusal would be a false positive — and a false
  // positive here breaks a build that works, which this file's own header
  // calls worse than the defect.
  //
  // Found by hitting it: two projects each declaring their own
  // install-as-an-action both capture the workspace-root `node_modules` under
  // a hoisting package manager, and the refusal fired on a pair that cannot
  // exhibit the hazard.
  it('two remote-only installs may both capture the workspace root', () => {
    expect(() =>
      graph({
        core: { setup: remoteOnlyTask([], ['node_modules']) },
        docs: { setup: remoteOnlyTask([], ['node_modules']) },
      }),
    ).not.toThrow()
  })

  it('one remote-only and one ordinary task is still allowed', () => {
    // The ordinary one cleans its own declared outputs, but the remote-only
    // task has nothing on this disk for that clean to destroy.
    expect(() =>
      graph({
        core: { setup: remoteOnlyTask([], ['node_modules']) },
        docs: { vendor: task([], ['node_modules']) },
      }),
    ).not.toThrow()
  })

  // CONTROL: the refusal is intact for the case it was written for. Without
  // this, "exempt remote-only" could silently degenerate into "exempt
  // everything" and the data-loss guard would be gone with a green suite.
  it('two ORDINARY tasks declaring the same output are still refused', () => {
    expect(() =>
      graph({
        core: { a: task([], ['node_modules']) },
        docs: { b: task([], ['node_modules']) },
      }),
    ).toThrow(/both declare the output/)
  })

  it('the project-relative namespace is exempted the same way', () => {
    expect(() =>
      graph({ core: { a: remoteOnlyTask(['dist/**']), b: task(['dist/**']) } }),
    ).not.toThrow()
    expect(() => graph({ core: { a: task(['dist/**']), b: task(['dist/**']) } })).toThrow(
      /both declare the output/,
    )
  })
})
