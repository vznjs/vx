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
import { buildTaskGraph, outputsOverlap, type TaskNode } from '../src/graph/index.js'
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

/** Like `graph`, returning the nodes, for the rows that read what the build marked. */
function graphNodes(projects: Record<string, Record<string, TaskConfig>>): Map<string, TaskNode> {
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
  return buildTaskGraph({
    projects: entries,
    packageGraph: pkg,
    requested: [...entries.values()].flatMap((e) =>
      Object.keys(e.config.tasks ?? {}).map((t) => ({ project: e.name, task: t })),
    ),
  })
}

describe('an overlap WITH an edge is the addition shape, and is allowed (item 588)', () => {
  // twenty's `build` → `dist` and `build:individual` → `dist/individual`,
  // the second depending on the first: the order is fixed, so the dependant
  // can add to the tree and tell its own files from what it found.
  const dependant = (outputs: string[], on: string): TaskConfig => ({
    ...task(outputs),
    dependsOn: [on],
  })

  it('marks the dependant as adding to the upstream, and the upstream as added to', () => {
    const nodes = graphNodes({
      app: { build: task(['dist']), individual: dependant(['dist/individual'], 'build') },
    })
    expect(nodes.get('app#individual')?.addsToOutputsOf).toEqual(['app#build'])
    expect(nodes.get('app#build')?.outputsAddedToBy).toEqual(['dist/individual'])
    expect(nodes.get('app#build')?.addsToOutputsOf).toBeUndefined()
  })

  it('the dependant is the additive one whichever is declared first, and through a hop', () => {
    const nodes = graphNodes({
      app: {
        individual: dependant(['dist/individual'], 'mid'),
        mid: { dependsOn: ['build'] } as TaskConfig,
        build: task(['dist']),
      },
    })
    expect(nodes.get('app#individual')?.addsToOutputsOf).toEqual(['app#build'])
    expect(nodes.get('app#build')?.outputsAddedToBy).toEqual(['dist/individual'])
  })

  it("strapi's shape: an identical glob is allowed too, once an edge orders it", () => {
    const nodes = graphNodes({
      app: { build: task(['dist/**']), types: dependant(['dist/**'], 'build') },
    })
    expect(nodes.get('app#types')?.addsToOutputsOf).toEqual(['app#build'])
  })

  it('workspace outputs across projects follow the same rule', () => {
    const nodes = graphNodes({
      a: { build: task([], ['shared/**']) },
      b: { build: { ...task([], ['shared/b.txt']), dependsOn: ['a#build'] } as TaskConfig },
    })
    expect(nodes.get('b#build')?.addsToOutputsOf).toEqual(['a#build'])
    expect(nodes.get('a#build')?.outputsAddedToBy).toEqual(['shared/b.txt'])
  })

  it('CONTROL: the same pair WITHOUT the edge is still refused', () => {
    expect(() =>
      graph({ app: { build: task(['dist']), individual: task(['dist/individual']) } }),
    ).toThrow(/both declare the output/)
  })

  it('CONTROL: an edge to a task with a DISJOINT output marks nothing', () => {
    const nodes = graphNodes({ app: { build: task(['dist']), docs: dependant(['out'], 'build') } })
    expect(nodes.get('app#docs')?.addsToOutputsOf).toBeUndefined()
    expect(nodes.get('app#build')?.outputsAddedToBy).toBeUndefined()
  })
})

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

  // `*` is not the only wildcard a glob can carry, and this refusal turns
  // on CLASSIFYING a spelling as literal or glob: a pattern mistaken for a
  // literal is compared by string equality, so it never matches the file it
  // really claims and the collision goes through. Narrowing the classifier
  // to `*` alone passed the entire suite, because every fixture above
  // spells its wildcard `*` — measured on the predicate, `dist/a?.txt` vs
  // `dist/ab.txt` and `dist/[ab].txt` vs `dist/a.txt` both go true → false
  // (item 494). The class left this list in item 667: a bracket is a
  // literal in a task glob, and the rows below the loop pin that reading.
  const otherWildcards: Array<[string, string, string]> = [
    ['?', 'dist/a?.txt', 'dist/ab.txt'],
    // This one was a LIVE defect, not just an unpinned claim: the
    // classifier this refusal read omitted braces, so `Bun.Glob` matched
    // `dist/a.txt` while the refusal compared two unequal strings and let
    // the pair through (item 495). One classifier now, in `util/paths.ts`,
    // where `asTrees` already went for the same reason.
    ['a brace alternation', 'dist/{a,b}.txt', 'dist/a.txt'],
  ]
  for (const [what, glob, literal] of otherWildcards) {
    it(`refuses a glob spelled with ${what} over a matching literal`, () => {
      expect(() => graph({ app: { all: task([glob]), one: task([literal]) } })).toThrow(
        /both declare the output/,
      )
      // Either order, like every other pair here.
      expect(() => graph({ app: { one: task([literal]), all: task([glob]) } })).toThrow(
        /both declare the output/,
      )
    })
  }

  it('CONTROL: those wildcards do not refuse a literal they do not match', () => {
    // Without this, the two rows above would also pass on a rule that
    // refused any pair merely containing a `?` or a brace.
    expect(() =>
      graph({ app: { a: task(['dist/a?.txt']), b: task(['dist/zz.txt']) } }),
    ).not.toThrow()
    expect(() =>
      graph({ app: { a: task(['dist/{a,b}.txt']), b: task(['dist/c.txt']) } }),
    ).not.toThrow()
  })

  // A bracket is a LITERAL in a task glob (item 667): `app/[id]` is a route
  // directory, not the class that also names `app/i`. So the route and the
  // class's sibling are two paths, and the refusal must not break a Next.js
  // app whose `app/i/page.js` sits beside `app/[id]/page.js` — while two
  // tasks that both declare the route do delete each other's file.
  it('a route directory overlaps itself and not the sibling a class would have matched', () => {
    expect(() =>
      graph({ app: { a: task(['app/[id]/page.js']), b: task(['app/i/page.js']) } }),
    ).not.toThrow()
    expect(() =>
      graph({ app: { a: task(['app/[id]/*.js']), b: task(['app/i/page.js']) } }),
    ).not.toThrow()
    expect(() =>
      graph({ app: { a: task(['app/i/page.js']), b: task(['app/[id]/*.js']) } }),
    ).not.toThrow()
    expect(() =>
      graph({ app: { a: task(['app/[id]/page.js']), b: task(['app/[id]/page.js']) } }),
    ).toThrow(/both declare the output/)
    expect(() =>
      graph({ app: { a: task(['app/[id]/*.js']), b: task(['app/[id]/page.js']) } }),
    ).toThrow(/both declare the output/)
    expect(() =>
      graph({ app: { a: task(['app/\\[id\\]/page.js']), b: task(['app/[id]/page.js']) } }),
    ).toThrow(/both declare the output/)
  })
})

describe('a literal entry is the file OR its whole tree', () => {
  // `asTrees` — the rule the input/output resolver and `cleanOutputs` both
  // read — compiles a literal to itself PLUS its subtree, because `dist`
  // and `dist/` mean everything under `dist` in Turbo, in `.gitignore` and
  // here. `"outputs": ["dist"]` is the most common turbo.json shape there
  // is. The refusal used to compare it as a plain literal, so `dist`
  // against `dist/app.js` was "no overlap" — and the task declaring `dist`
  // deleted the other's file on every run, green (item 442, measured
  // through a real run before this row existed).
  const swallowed: [string, string][] = [
    ['dist', 'dist/app.js'],
    ['dist/', 'dist/app.js'],
    ['dist', 'dist/**'],
    ['dist', 'dist/sub/deep.txt'],
    ['./dist/', 'dist/sub/deep.txt'],
  ]
  for (const [wide, narrow] of swallowed) {
    it(`refuses ${wide} against ${narrow}`, () => {
      expect(() => graph({ app: { wide: task([wide]), narrow: task([narrow]) } })).toThrow(
        /both declare the output/,
      )
      // Either order — the deletion does not care which task is visited
      // first, so neither may the refusal.
      expect(() => graph({ app: { narrow: task([narrow]), wide: task([wide]) } })).toThrow(
        /both declare the output/,
      )
    })
  }

  it('CONTROL: a literal directory does not swallow a SIBLING directory', () => {
    // The tree rule reaches down, never sideways. `dist` and `build` are
    // two trees; `dist` and `distant` are two names, and the second is not
    // under the first however similar the prefix looks.
    expect(() => graph({ app: { a: task(['dist']), b: task(['build']) } })).not.toThrow()
    expect(() => graph({ app: { a: task(['dist']), b: task(['distant/app.js']) } })).not.toThrow()
    expect(() => graph({ app: { a: task(['dist/a']), b: task(['dist/b']) } })).not.toThrow()
  })

  it('the tree rule stops where the glob-vs-glob case starts, and that is a LIMIT', () => {
    // `asTrees` turns the literal `dist` into the glob `dist/**`, so
    // `dist` against `dist/sub/**` is glob vs glob — the case this file
    // deliberately leaves undecided rather than risk refusing a working
    // config. It really does overlap, and vx really will delete it; the
    // narrow side has to be a LITERAL (or the identical glob) to be
    // provable without a general intersection algorithm. Pinned so the
    // hole is a decision and not an accident — this is the second row
    // that widens when that algorithm arrives.
    expect(() => graph({ app: { a: task(['dist']), b: task(['dist/sub/**']) } })).not.toThrow()
  })

  it('CONTROL: a literal FILE has no subtree to swallow with', () => {
    // `asTrees` gives every literal a `/**` twin, a file included, and
    // nothing lives under a file — so the twin must match nothing rather
    // than make two unrelated files collide.
    expect(() =>
      graph({ app: { a: task(['dist/app.js']), b: task(['dist/app.js.map']) } }),
    ).not.toThrow()
  })
})

describe('the same path, spelled differently, is the same path', () => {
  // The refusal compares SPELLINGS — two literals for equality, a literal
  // against a glob through `Bun.Glob`, two globs for equality. Every one of
  // those said "no overlap" for `./dist/**` against `dist/**`, while
  // `cleanOutputs` — which does the actual deleting — resolves both to one
  // tree. So the pairs below kept exactly the data loss this check exists
  // to refuse, silently (item 441).
  const same: [string, string][] = [
    ['./dist/app.js', 'dist/app.js'],
    ['./dist/**', 'dist/**'],
    ['dist//**', 'dist/**'],
    ['dist/./app.js', 'dist/app.js'],
    ['dist/**', './dist/app.js'],
    ['./dist/vx-*', 'dist/vx-linux-x64'],
  ]
  for (const [a, b] of same) {
    it(`refuses ${a} against ${b}`, () => {
      expect(() => graph({ app: { one: task([a]), two: task([b]) } })).toThrow(
        /both declare the output/,
      )
    })
  }

  it('quotes what the user actually wrote, not the normalized form', () => {
    // The message has to be findable in their config file.
    let msg = ''
    try {
      graph({ app: { one: task(['./dist/**']), two: task(['dist/**']) } })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('"./dist/**"')
    expect(msg).toContain('"dist/**"')
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

  it('normalizing the spelling does not widen what is refused', () => {
    // The control for the spelling rows above: folding `./` and `//` makes
    // equal paths compare equal, and nothing else. These pairs are still
    // undecidable or disjoint after it, so they still go through.
    expect(() =>
      graph({ app: { a: task(['./dist/vx-*']), b: task(['dist/other.txt']) } }),
    ).not.toThrow()
    expect(() =>
      graph({ app: { a: task(['./dist/a/**']), b: task(['dist//b/**']) } }),
    ).not.toThrow()
    expect(() =>
      graph({ app: { a: task(['./dist/*.js']), b: task(['dist/**/*.js']) } }),
    ).not.toThrow()
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

  it('stays near-linear in ONE project: 4,000 tasks with outputs', () => {
    // Indexing by project left each project's own tasks all-pairs, so one
    // project of 4,000 tasks with outputs spent 10.7 s here (item 741). The
    // old loop's best of three on this box: 10.0 s for distinct literals,
    // 2.65 s for distinct globs; indexed by path (item 745), 5 ms warm and
    // about 10 ms on a first build. The bound fails the old loop ten times
    // over at its cheapest shape and leaves the index 25 times its cost.
    const TASKS = 4_000
    const literals: Record<string, TaskConfig> = {}
    const globs: Record<string, TaskConfig> = {}
    for (let t = 0; t < TASKS; t++) {
      literals[`t${t}`] = task([`dist/t${t}.js`])
      globs[`t${t}`] = task([`out/t${t}/**`])
    }
    for (const tasks of [literals, globs]) {
      let best = Infinity
      for (let r = 0; r < 3; r++) {
        const t0 = performance.now()
        graph({ app: tasks })
        best = Math.min(best, performance.now() - t0)
      }
      expect(best).toBeLessThan(250)
    }
  }, 120_000)
})

// The pairs compared inside one domain come from a path index
// (`overlapCandidates`, item 745), which must find every pair the rule
// refuses: a pair it misses is two tasks deleting each other's outputs,
// green. Each row is a way an index by path could miss one.
describe('the path index finds every pair the rule refuses', () => {
  const found: Array<[string, string, string]> = [
    ['a literal deep under a glob’s head', 'dist/a/**', 'dist/a/b/c/d.js'],
    ['a wildcard in the first segment', '*/app.js', 'dist/app.js'],
    ['a brace in the first segment', '{dist,lib}/app.js', 'lib/app.js'],
    ['a wildcard at the root', '*.js', 'app.js'],
    ['a globstar at the root', '**/app.js', 'dist/sub/app.js'],
    ['an escape in the head (`\\s` is `s`)', 'di\\st/*.js', 'dist/app.js'],
    ['a literal directory over a deep literal', 'dist', 'dist/a/b/c.js'],
    ['a glob over the directory its head names', 'dist/**', 'dist'],
    ['a trailing wildcard in the last segment', 'dist/app*', 'dist/app.js'],
  ]
  for (const [what, glob, literal] of found) {
    it(`${what}: ${glob} against ${literal}`, () => {
      expect([outputsOverlap(glob, literal), outputsOverlap(literal, glob)]).toEqual([true, true])
      expect(() => graph({ app: { a: task([glob]), b: task([literal]) } })).toThrow(
        /both declare the output/,
      )
      expect(() => graph({ app: { b: task([literal]), a: task([glob]) } })).toThrow(
        /both declare the output/,
      )
      expect(() => graph({ p: { a: task([], [glob]) }, q: { b: task([], [literal]) } })).toThrow(
        /cache\.outputs\.workspaceFiles/,
      )
    })
  }

  it('CONTROL: a literal beside a glob’s head, not under it, is not compared into a refusal', () => {
    expect(() =>
      graph({ app: { a: task(['dist/a/**']), b: task(['dist/ab/c.js', 'dist/b.js']) } }),
    ).not.toThrow()
  })

  it('names the first colliding pair in declaration order, as all pairs did', () => {
    let msg = ''
    try {
      graph({
        app: {
          w: task(['x/1.js']),
          v: task(['gen/**']),
          u: task(['y/2.js', 'gen/a.js']),
          t: task(['x/1.js']),
        },
      })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg.slice(0, msg.indexOf(' in cache.'))).toBe(
      'app#w and app#t both declare the output "x/1.js"',
    )
  })

  it('pushes the addition marks in all-pairs order', () => {
    const on = (outputs: string[], deps: string[]): TaskConfig => ({
      ...task(outputs),
      dependsOn: deps,
    })
    const nodes = graphNodes({
      app: {
        top: on(['dist/top/a.js', 'dist/top/b.js'], ['mid', 'base']),
        mid: on(['dist/top/**'], ['base']),
        base: task(['dist']),
      },
    })
    expect(
      ['top', 'mid', 'base'].map((t) => {
        const n = nodes.get(`app#${t}`)!
        return [n.id, n.addsToOutputsOf, n.outputsAddedToBy]
      }),
    ).toEqual(reference(nodes).map((n) => [n.id, n.addsToOutputsOf, n.outputsAddedToBy]))
  })

  // The differential: random configs, the index against the all-pairs loop
  // it replaced, over the same exported rule. Each config runs twice: with
  // no edges (a refusal, naming the first pair) and as a chain (every pair
  // ordered, so the addition marks, in order).
  const SEGMENTS = [
    'dist',
    'lib',
    'a',
    'b',
    '*',
    '**',
    '{a,b}',
    '{dist,lib}',
    'a?',
    'di\\st',
    '*.js',
    // A leading `!` negates in `Bun.Glob`; the schema refuses it in an
    // output, but the rule answers for it, so the index must too.
    '!a',
  ]
  it('matches all pairs on 3,000 random configs, both namespaces', () => {
    let seed = 745
    const rnd = (n: number): number => {
      // mulberry32: an LCG's low bits cycle in a few steps, and `% n` reads
      // them, so some segment sequences never came up.
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) % n
    }
    const glob = (): string => {
      const parts: string[] = []
      for (let d = 0, depth = 1 + rnd(3); d < depth; d++)
        parts.push(SEGMENTS[rnd(SEGMENTS.length)]!)
      const g = parts.join('/')
      return rnd(8) === 0 ? `./${g}` : rnd(8) === 0 ? `${g}/` : g
    }
    let refusals = 0
    let marks = 0
    for (let c = 0; c < 1_500; c++) {
      const outputs = Array.from({ length: 2 + rnd(6) }, () =>
        Array.from({ length: 1 + rnd(2) }, glob),
      )
      for (const ws of [false, true]) {
        const at = (i: number, deps?: string[]): TaskConfig => ({
          ...(ws ? task([], outputs[i]) : task(outputs[i]!)),
          ...(deps === undefined ? {} : { dependsOn: deps }),
        })
        const loose: Record<string, Record<string, TaskConfig>> = {}
        const chain: Record<string, TaskConfig> = {}
        outputs.forEach((_, i) => {
          if (ws) loose[`p${i}`] = { t: at(i) }
          else (loose['app'] ??= {})[`t${i}`] = at(i)
          chain[`t${i}`] = at(i, i + 1 < outputs.length ? [`t${i + 1}`] : [])
        })
        const unordered = graphNodesOrError(loose)
        const expected = firstRefusal(unordered.order, ws)
        if (expected !== null) refusals++
        expect(unordered.error).toBe(expected)

        const nodes = graphNodes({ app: chain })
        const want = reference(nodes, ws)
        marks += want.filter((n) => n.addsToOutputsOf !== undefined).length
        expect(
          [...nodes.values()].map((n) => [n.id, n.addsToOutputsOf, n.outputsAddedToBy]),
        ).toEqual(want.map((n) => [n.id, n.addsToOutputsOf, n.outputsAddedToBy]))
      }
    }
    // The configs exercise both outcomes, or the comparison holds nothing.
    expect(refusals).toBeGreaterThan(500)
    expect(marks).toBeGreaterThan(500)
  }, 60_000)
})

const outputsOf = (n: TaskNode, ws: boolean): readonly string[] =>
  (ws ? n.config.cache?.outputs.workspaceFiles : n.config.cache?.outputs.files) ?? []

/** Build unordered: the node order (for the reference) and the refusal's head, if any. */
function graphNodesOrError(projects: Record<string, Record<string, TaskConfig>>): {
  order: TaskNode[]
  error: string | null
} {
  // The graph is refused whole, so its node order is read from a build
  // with outputs stripped: collisions are the last step of the build.
  const bare: Record<string, Record<string, TaskConfig>> = {}
  for (const [p, tasks] of Object.entries(projects)) {
    bare[p] = Object.fromEntries(
      Object.entries(tasks).map(([t, c]): [string, TaskConfig] => [t, { exec: c.exec! }]),
    )
  }
  const order = [...graphNodes(bare).values()].map((n) => ({
    ...n,
    config: projects[n.projectName]![n.taskName]!,
  }))
  try {
    graph(projects)
    return { order, error: null }
  } catch (e) {
    const msg = (e as Error).message
    return { order, error: msg.slice(0, msg.indexOf(' — vx cleans')) }
  }
}

/** The all-pairs refusal's head: the first overlapping pair and globs, in node order. */
function firstRefusal(order: readonly TaskNode[], ws: boolean): string | null {
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!
      const b = order[j]!
      if (!ws && a.projectName !== b.projectName) continue
      for (const ga of outputsOf(a, ws)) {
        for (const gb of outputsOf(b, ws)) {
          if (!outputsOverlap(ga, gb)) continue
          return (
            `${a.id} and ${b.id} both declare the output ${JSON.stringify(ga)}` +
            (ga === gb ? '' : ` / ${JSON.stringify(gb)}`) +
            ` in cache.outputs.${ws ? 'workspaceFiles' : 'files'}`
          )
        }
      }
    }
  }
  return null
}

/** The all-pairs addition marks over a built graph whose every overlap is ordered. */
function reference(
  nodes: Map<string, TaskNode>,
  ws = false,
): Array<{ id: string; addsToOutputsOf?: string[]; outputsAddedToBy?: string[] }> {
  const below = (from: string, to: string): boolean => {
    const stack = [...nodes.get(from)!.deps]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const id = stack.pop()!
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...nodes.get(id)!.deps)
    }
    return false
  }
  const out = new Map(
    [...nodes.keys()].map((id) => [
      id,
      { id } as { id: string; addsToOutputsOf?: string[]; outputsAddedToBy?: string[] },
    ]),
  )
  const order = [...nodes.values()].filter((n) => outputsOf(n, ws).length > 0)
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!
      const b = order[j]!
      if (!ws && a.projectName !== b.projectName) continue
      const hit = outputsOf(a, ws).some((ga) =>
        outputsOf(b, ws).some((gb) => outputsOverlap(ga, gb)),
      )
      if (!hit) continue
      const [up, down] = below(b.id, a.id) ? [a, b] : [b, a]
      ;(out.get(down.id)!.addsToOutputsOf ??= []).push(up.id)
      ;(out.get(up.id)!.outputsAddedToBy ??= []).push(...outputsOf(down, ws))
    }
  }
  return [...out.values()]
}

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

  it('a LITERAL directory output deletes the tree, which is why it collides', async () => {
    // The premise the row above assumes for `dist/**` and the refusal now
    // reads for `dist`: a literal entry is the file OR its whole tree
    // (`asTrees`), so declaring `dist` wipes everything under it. Without
    // this, refusing `dist` against `dist/app.js` would be a false
    // positive — and this file's header calls that worse than the defect.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-collide-lit-'))
    try {
      const { cleanOutputs } = await import('../src/cache/index.js')
      await mkdir(path.join(dir, 'dist', 'sub'), { recursive: true })
      await writeFile(path.join(dir, 'dist', 'app.js'), 'built by app#emit')
      await writeFile(path.join(dir, 'dist', 'sub', 'deep.txt'), 'also app#emit')

      await cleanOutputs({ projectDir: dir, outputs: ['dist'], nestedProjectDirs: [] })

      expect(await Bun.file(path.join(dir, 'dist', 'app.js')).exists()).toBe(false)
      expect(await Bun.file(path.join(dir, 'dist', 'sub', 'deep.txt')).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('CONTROL: a literal FILE output deletes only that file', async () => {
    // The other half of the same rule, so the row above cannot pass by
    // deleting indiscriminately.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-collide-file-'))
    try {
      const { cleanOutputs } = await import('../src/cache/index.js')
      await mkdir(path.join(dir, 'dist'), { recursive: true })
      await writeFile(path.join(dir, 'dist', 'app.js'), 'mine')
      await writeFile(path.join(dir, 'dist', 'other.js'), 'not mine')

      await cleanOutputs({ projectDir: dir, outputs: ['dist/app.js'], nestedProjectDirs: [] })

      expect(await Bun.file(path.join(dir, 'dist', 'app.js')).exists()).toBe(false)
      expect(await Bun.file(path.join(dir, 'dist', 'other.js')).exists()).toBe(true)
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
