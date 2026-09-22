import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { addProject, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import {
  Cache,
  FULL_CACHE_POLICY,
  LayeredCache,
  type RemoteCacheLayer,
} from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { prepareRun, run } from '../src/orchestrator/index.js'
import { startLocalShortCircuit } from '../src/orchestrator/local-shortcircuit.js'
import { shouldShortCircuit } from '../src/orchestrator/run.js'

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
      fixture.err.push(chunk.trimEnd())
      buffers.set(node.id, (buffers.get(node.id) ?? '') + chunk)
    },
    taskComplete(node, outcome) {
      const body = buffers.get(node.id) ?? ''
      buffers.delete(node.id)
      fixture.log.push(`task ${node.id} ${outcome.status}`)
      if (body.trim().length > 0) fixture.log.push(body.trimEnd())
    },
  }
}

async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-sc-' })
  return { root, log: [], err: [] }
}

/** Classify the graph the same way run() does: prepare, then probe. */
async function classify(
  fixture: Fixture,
  tasks: string[],
): Promise<{ restoreTier: Set<string>; preProbedIds: Set<string> }> {
  const prepared = await prepareRun(
    { cwd: fixture.root, tasks, log: silentLogger(fixture) },
    silentLogger(fixture),
  )
  try {
    const sc = await startLocalShortCircuit({
      nodes: prepared.nodes,
      cache: prepared.cache,
      workspaceRoot: prepared.workspaceRoot,
      workspaceFingerprint: prepared.workspaceFingerprint,
      nestedDirsByProject: prepared.nestedDirsByProject,
      gitFilesCache: prepared.gitFilesCache,
      hashCache: prepared.hashCache,
      concurrency: 4,
    })
    return { restoreTier: sc.restoreTier, preProbedIds: new Set(sc.preProbed.keys()) }
  } finally {
    prepared.cache.close()
  }
}

describe('local cache short-circuit', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'cross-project stable hit is restore-tier; outputs correct, dependents unblocked',
    async () => {
      // lib#build writes dist/out.txt (a real output in its own dir).
      // app#build depends on lib#build (ordering) but reads only src/**
      // — its key cannot be altered by lib's outputs (different project,
      // gitignored output dir). On a warm run app#build is a stable hit.
      await addProject(fixture.root, 'lib', {
        files: { 'src/a.txt': 'a', '.gitignore': 'dist/\n' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "mkdir -p dist && node -e 'process.stdout.write(String(Date.now()))' > dist/out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const appDir = await addProject(fixture.root, 'app', {
        deps: { lib: 'workspace:*' },
        files: { 'src/b.txt': 'b', '.gitignore': 'dist/\n' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^build'],
                exec: { command: "mkdir -p dist && node -e 'process.stdout.write(String(Date.now()))' > dist/built.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })

      // Cold: both run.
      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)
      const builtBytes = await readFile(path.join(appDir, 'dist/built.txt'), 'utf8')

      // Wipe app's output so the warm run must materialize the restore.
      await rm(path.join(appDir, 'dist'), { recursive: true, force: true })

      // Classify: app#build (and lib#build) are stable hits → restore-tier.
      const c = await classify(fixture, ['build'])
      expect(c.restoreTier.has('app#build')).toBe(true)
      expect(c.restoreTier.has('lib#build')).toBe(true)

      // Warm: app#build restores; outputs are correct (byte-identical).
      const warm = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(warm.ok).toBe(true)
      const appOutcome = warm.outcomes.find((o) => o.node.id === 'app#build')
      expect(appOutcome?.status).toBe('cache-hit')
      expect(await readFile(path.join(appDir, 'dist/built.txt'), 'utf8')).toBe(builtBytes)
    },
    TIMEOUT,
  )

  it(
    'codegen-into-shared-project dependent is NOT restore-tier (stays exec-tier)',
    async () => {
      // codegen writes generated.txt INTO its own project dir; consumer
      // is a same-project task whose inputs (`**/*`) can match that
      // output — its key is preliminary until codegen runs, so it must
      // NOT be restored ahead of the schedule.
      await addProject(fixture.root, 'gen', {
        files: { 'src/seed.txt': 'seed' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > generated.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
              },
              consume: {
                dependsOn: ['codegen'],
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      // Cold run populates the cache.
      const cold = await run({ cwd: fixture.root, tasks: ['consume'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)

      const c = await classify(fixture, ['consume'])
      // codegen has no same-project upstream with outputs → stable hit.
      expect(c.restoreTier.has('gen#codegen')).toBe(true)
      // consume reads `**/*` which can match codegen's generated.txt →
      // unstable → NEVER probed up front, never restore-tier.
      expect(c.preProbedIds.has('gen#consume')).toBe(false)
      expect(c.restoreTier.has('gen#consume')).toBe(false)

      // And the warm run is still correct (consume hits via lazy probe).
      const warm = await run({ cwd: fixture.root, tasks: ['consume'], log: silentLogger(fixture) })
      expect(warm.ok).toBe(true)
      expect(warm.outcomes.find((o) => o.node.id === 'gen#consume')?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a workspaceFiles consumer reaching into a dependency output is classified unstable',
    async () => {
      // pkga#gen writes gen/lib.txt (a real PROJECT output). pkgb#build reads
      // it through a boundary-free `inputs.workspaceFiles` glob AND decouples
      // the upstream hash (`inputs.tasks: []`) — a legitimate content-based
      // invalidation config. pkgb#build's key therefore depends on pkga's
      // OUTPUT, so it must be classified UNSTABLE: never restore-tiered, and
      // (crucially) never preProbed — execute-task reuses a preProbed hash
      // WITHOUT recomputing, so a preliminary key in preProbed is itself a
      // stale-hit vector (the misclassified consumer would restore bytes keyed
      // off pkga's STALE output). This is the cross-project outputs.files reach
      // the old dependsOnSiblingOutputs missed: it only compared a dep's
      // outputs.workspaceFiles for a ws-reader, never a dep's outputs.files.
      await addProject(fixture.root, 'pkga', {
        files: { 'src/seed.txt': 'v1' },
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: "mkdir -p gen && cp src/seed.txt gen/lib.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'pkgb', {
        deps: { pkga: 'workspace:*' },
        files: { 'src/b.txt': 'b' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['pkga#gen'],
                exec: { command: "cp ../pkga/gen/lib.txt out.txt" },
                cache: {
                  inputs: { files: ['src/**'], tasks: [], workspaceFiles: ['packages/pkga/gen/**'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })

      // Populate the cache so an up-front HIT is possible — the classification
      // (graph-structural, independent of cache/source state) must still
      // exclude pkgb#build regardless.
      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)

      const c = await classify(fixture, ['build'])
      // Control: pkga#gen has no output-producing upstream → STABLE (the fix
      // does not over-mark; the restore-tier optimization is preserved).
      expect(c.preProbedIds.has('pkga#gen')).toBe(true)
      // pkgb#build reaches pkga's output via workspaceFiles → UNSTABLE: never
      // preProbed (so execute recomputes its key lazily after gen runs), never
      // restore-tiered.
      expect(c.preProbedIds.has('pkgb#build')).toBe(false)
      expect(c.restoreTier.has('pkgb#build')).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a workspace-output producer upstream takes its dependents out of BOTH tiers',
    async () => {
      // lib declares a WORKSPACE output (root-anchored, boundary-ignoring).
      //
      // This test used to assert the opposite of its second half — that probe
      // reuse "still applies, so every stable task is still in preProbed (no
      // double work)". That was the defect, encoded: a root-anchored output can
      // land inside a dependent's own project dir, so the dependent's key is
      // preliminary; and `preProbed` is reused VERBATIM by execute-task, which
      // makes probe reuse the half that actually serves the stale bytes. The
      // graph-wide restore-tier disable covered the other half only.
      // `tests/stale-hit.test.ts` drives the resulting wrong answer end to end.
      await addProject(fixture.root, 'wlib', {
        files: { 'src/a.txt': 'a' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "mkdir -p ../../shared && echo x > ../../shared/g.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['shared/g.txt'] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'wapp', {
        deps: { wlib: 'workspace:*' },
        files: { 'src/b.txt': 'b' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^build'],
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)

      const c = await classify(fixture, ['build'])
      // The dependent is unstable, so it is in NEITHER tier: it probes lazily
      // in execute-task, after its upstream has actually run.
      expect(c.preProbedIds.has('wapp#build')).toBe(false)
      // The restore tier holds the PRODUCER alone (item 584): its key is
      // stable and its early restore lands where nothing else in the tier
      // reads; before 584 a workspace output anywhere emptied the tier.
      expect([...c.restoreTier]).toEqual(['wlib#build'])
      // The PRODUCER keeps its own short-circuit — it has no output producer
      // upstream of itself, so its key was never preliminary. Without this the
      // fix could have been "mark everything unstable", which would pass the
      // assertion above while silently disabling the optimisation wholesale.
      expect(c.preProbedIds.has('wlib#build')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a producer reached THROUGH a stable intermediate still poisons the key',
    async () => {
      // The transitive fold in `deriveStableKeys`, which nothing drove over a
      // real graph. The one-hop case is the `gen#codegen` row above, and there
      // the dependent is caught by the direct gate; the fold only matters when
      // the intermediate is itself STABLE, so instability cannot simply be
      // inherited along the edge.
      //
      // The arrangement that isolates it: the producer and the reader are the
      // SAME project (so a project-relative input can reach the output), and
      // the intermediate is a DIFFERENT one (so it is stable — its own inputs
      // are out of the producer's reach). a#codegen → b#mid → a#consume.
      // Only the accumulated producer set carries `a` across `b#mid`.
      await addProject(fixture.root, 'a', {
        files: { 'src/seed.txt': 'seed' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > generated.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
              },
              consume: {
                dependsOn: ['b#mid'],
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'b', {
        files: { 'src/m.txt': 'm' },
        config: `
          export default {
            tasks: {
              mid: {
                dependsOn: ['a#codegen'],
                exec: { command: 'true' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })

      const cold = await run({ cwd: fixture.root, tasks: ['consume'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)

      const c = await classify(fixture, ['consume'])
      // `a#consume` reads `**/*`, which can match the `generated.txt` its
      // same-project `a#codegen` writes two edges up: preliminary key, so it
      // is never probed up front and never restore-tier.
      expect(c.preProbedIds.has('a#consume')).toBe(false)
      expect(c.restoreTier.has('a#consume')).toBe(false)
      // CONTROLS. The intermediate is STABLE — which is the whole point: the
      // reader cannot be inheriting instability from it. And the producer,
      // with nothing upstream of itself, keeps its own short-circuit.
      expect(c.restoreTier.has('b#mid')).toBe(true)
      expect(c.restoreTier.has('a#codegen')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a CROSS-PROJECT dependent inherits its dep’s instability, which no producer set carries',
    async () => {
      // The third carrier in `deriveStableKeys`, and the one nothing drove.
      // 426 pinned the producer-set fold; this is the `unstable` FLAG that
      // travels along an edge, and removing it alone left the whole repo
      // green because the fold covers the same ground wherever the dependent
      // shares a project with the producer.
      //
      // The arrangement that isolates it inverts the fold rows above: the
      // producer and the unstable reader are the SAME project (so the reader
      // is caught by the direct gate), and the DEPENDENT is another project
      // reading only its own dir. Its producer set is {ia}, its own project
      // is ib, and the gate's documented answer for that is STABLE ("a
      // project-relative reader whose only upstream producer is ANOTHER
      // project"). So the flag is the only thing that can carry.
      //
      // It has to carry: ib#app folds ia#read's key, and that key is
      // PRELIMINARY until ia#codegen has run. Probing ib#app up front would
      // key it on a number that is not yet the number.
      await addProject(fixture.root, 'ia', {
        files: { 'src/seed.txt': 'seed' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > generated.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
              },
              read: {
                dependsOn: ['codegen'],
                exec: { command: 'true' },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'ib', {
        files: { 'src/m.txt': 'm' },
        config: `
          export default {
            tasks: {
              app: {
                dependsOn: ['ia#read'],
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const cold = await run({ cwd: fixture.root, tasks: ['app'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)

      const c = await classify(fixture, ['app'])
      expect(c.preProbedIds.has('ib#app')).toBe(false)
      expect(c.restoreTier.has('ib#app')).toBe(false)
      // CONTROLS. `ia#read` is unstable by the GATE, so it is the source of
      // the flag rather than another inheritor; and the producer, with
      // nothing upstream of itself, keeps its own short-circuit — so the
      // fixture is not simply classifying everything unstable.
      expect(c.restoreTier.has('ia#read')).toBe(false)
      expect(c.restoreTier.has('ia#codegen')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a GROUP carries its members’ instability to the group’s dependents',
    async () => {
      // The same flag across a group. A group is never gated (no cache), so
      // the ONLY way instability reaches past it is the member check — and
      // dropping that also left the whole repo green. Note the difference
      // from the workspace-output row below, which needs the group to stay
      // STABLE: there the producer's own dependents are unstable outright,
      // so a group whose member is the producer inherits nothing.
      //
      // ga#codegen → ga#read (unstable by the gate) → ga#all (group) →
      // gb#app (another project, reads only its own dir).
      await addProject(fixture.root, 'ga', {
        files: { 'src/seed.txt': 'seed' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > generated.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
              },
              read: {
                dependsOn: ['codegen'],
                exec: { command: 'true' },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: [] } },
              },
              all: { dependsOn: ['read'] },
            },
          }
        `,
      })
      await addProject(fixture.root, 'gb', {
        files: { 'src/m.txt': 'm' },
        config: `
          export default {
            tasks: {
              app: {
                dependsOn: ['ga#all'],
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const cold = await run({ cwd: fixture.root, tasks: ['app'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)

      const c = await classify(fixture, ['app'])
      expect(c.preProbedIds.has('gb#app')).toBe(false)
      expect(c.restoreTier.has('gb#app')).toBe(false)
      // CONTROLS, as above.
      expect(c.restoreTier.has('ga#read')).toBe(false)
      expect(c.restoreTier.has('ga#codegen')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'the workspace-output flag crosses a GROUP intermediate too',
    async () => {
      // The second half of the same fold. `wsOutputUpstream` is a separate
      // accumulator, and isolating it takes a different intermediate: a
      // root-anchored producer makes its DIRECT dependents unstable outright,
      // so an ordinary task in the middle would inherit instability and prove
      // nothing. A GROUP task does not — it has no cache and is never gated,
      // only marked unstable when a member is — so a group over the producer
      // stays stable and the flag is the only thing that can cross it.
      //
      // wa#gen (root-anchored output) → wa#all (group) → wa#consume.
      await addProject(fixture.root, 'wa', {
        files: { 'src/seed.txt': 'seed' },
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: "mkdir -p ../../shared && echo x > ../../shared/g.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['shared/g.txt'] } },
              },
              all: { dependsOn: ['gen'] },
              consume: {
                dependsOn: ['all'],
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })

      const cold = await run({ cwd: fixture.root, tasks: ['consume'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)

      const c = await classify(fixture, ['consume'])
      // Preliminary key: a root-anchored output two edges up could land where
      // `src/**` reads. Not probed up front — and the restore tier is off for
      // the whole graph anyway, which is why this row asserts on `preProbed`,
      // the half that execute-task reuses verbatim.
      expect(c.preProbedIds.has('wa#consume')).toBe(false)
      // CONTROL: the producer itself keeps its short-circuit, so the reader's
      // exclusion is the flag crossing the group, not a graph-wide bail-out.
      expect(c.preProbedIds.has('wa#gen')).toBe(true)
    },
    TIMEOUT,
  )

  // The writer rows below share one shape: `solo` has no edge to the
  // writer `wsw` in either direction, and only the writer's declared
  // workspace output changes between rows. Item 425 pinned the graph-wide
  // rule ("a workspace-output writer anywhere keeps an UNRELATED project out
  // of the tier"); item 584 replaced it with a reach test, and its reason is
  // kept exactly — a root-anchored output can land in ANY project's
  // directory, edge or no edge — as the second row. `docs/design/
  // overlapping-outputs-2026-09.md` asks for that row by name.
  const soloAndWriter = async (outputs: string): Promise<(o: string) => Promise<void>> => {
    await addProject(fixture.root, 'solo', {
      files: { 'src/a.txt': 'a' },
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
            },
          },
        }
      `,
    })
    const writerConfig = (o: string): string => `
      export default {
        tasks: {
          build: {
            exec: { command: "mkdir -p ../../shared ../solo/gen && echo x > ../../shared/g.txt && echo y > ../solo/gen/g.txt" },
            cache: { inputs: { files: ['src/**'] }, outputs: ${o} },
          },
        },
      }
    `
    await addProject(fixture.root, 'wsw', {
      files: { 'src/b.txt': 'b' },
      config: writerConfig(outputs),
    })
    return (o: string) =>
      Bun.write(path.join(fixture.root, 'packages', 'wsw', 'vx.config.mjs'), writerConfig(o)).then(
        () => undefined,
      )
  }

  it(
    "an unrelated project the writer's output cannot reach stays IN the tier",
    async () => {
      // The new behaviour (item 584): `shared/g.txt` reaches nothing under
      // `packages/solo`, so `solo` keeps its restore-tier hit. Before 584
      // this row read `false` — the graph-wide rule. CONTROL: the same
      // graph with the writer's output made project-relative, which never
      // excluded anyone, reads the same.
      const rewrite = await soloAndWriter(`{ files: [], workspaceFiles: ['shared/g.txt'] }`)
      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)
      const c = await classify(fixture, ['build'])
      expect(c.preProbedIds.has('solo#build')).toBe(true)
      expect(c.restoreTier.has('solo#build')).toBe(true)
      await rewrite(`{ files: ['out.txt'] }`)
      expect((await classify(fixture, ['build'])).restoreTier.has('solo#build')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "an unrelated project whose DIRECTORY the writer's output reaches stays OUT",
    async () => {
      // Item 425's claim, now path-based and still edge-free: the writer
      // declares `packages/solo/gen/g.txt`, so `solo`'s directory is where
      // a restore-tier restore and a later write could meet, and `solo`
      // stays dep-gated. Its probe-reuse entry stays (no double work).
      const rewrite = await soloAndWriter(
        `{ files: [], workspaceFiles: ['packages/solo/gen/g.txt'] }`,
      )
      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)
      const c = await classify(fixture, ['build'])
      expect(c.preProbedIds.has('solo#build')).toBe(true)
      expect(c.restoreTier.has('solo#build')).toBe(false)
      // CONTROL: the writer's own project is not reached by its own output,
      // so it keeps the tier — the exclusion is the path, not the declaring.
      expect(c.restoreTier.has('wsw#build')).toBe(true)
      // And the flip is the path alone: move the output out of solo's tree.
      await rewrite(`{ files: [], workspaceFiles: ['shared/g.txt'] }`)
      expect((await classify(fixture, ['build'])).restoreTier.has('solo#build')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a workspace output with no literal prefix keeps the graph-wide rule',
    async () => {
      // `**/g.txt` can land anywhere, so every task stays out, the writer
      // included — exactly the rule 584 replaced, kept for the spelling
      // that earns it.
      await soloAndWriter(`{ files: [], workspaceFiles: ['**/g.txt'] }`)
      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)
      const c = await classify(fixture, ['build'])
      expect(c.preProbedIds.has('solo#build')).toBe(true)
      expect(c.restoreTier.size).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'exclusion follows the edges down: a dependant of a reached project stays OUT',
    async () => {
      // `dep` depends on `solo` and nothing reaches `dep`'s directory, but
      // its up-front key folds `solo`'s, which is preliminary while a write
      // may land in `solo`'s tree; restoring `dep` early would restore an
      // artifact keyed on the wrong `solo`. Its stability gate cannot see
      // this (`solo` is not a WORKSPACE writer), so the exclusion carries it.
      await soloAndWriter(`{ files: [], workspaceFiles: ['packages/solo/gen/g.txt'] }`)
      await addProject(fixture.root, 'dep', {
        files: { 'src/c.txt': 'c' },
        deps: { solo: '*' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^build'],
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)
      const c = await classify(fixture, ['build'])
      expect(c.preProbedIds.has('dep#build')).toBe(true)
      expect(c.restoreTier.has('dep#build')).toBe(false)
      // CONTROL: with the writer's output out of solo's tree, dep is in.
      await Bun.write(
        path.join(fixture.root, 'packages', 'wsw', 'vx.config.mjs'),
        `export default { tasks: { build: { exec: { command: "mkdir -p ../../shared && echo x > ../../shared/g.txt" }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [], workspaceFiles: ['shared/g.txt'] } } } } }`,
      )
      expect((await classify(fixture, ['build'])).restoreTier.has('dep#build')).toBe(true)
    },
    TIMEOUT,
  )

  it(
    "the design note's cross-project overlap stays dep-gated on both sides",
    async () => {
      // `docs/design/overlapping-outputs-2026-09.md`'s fixture: `a#build`
      // writes `dist/**`, `b#build` declares a workspace output INSIDE a's
      // dist, depends on a, and detaches its key with `inputs.tasks: []` so
      // it could hit while a misses — the one arrangement in which b could
      // restore into a directory a is about to clean. Under the reach rule
      // (item 584) b's output reaches a's directory, so a is kept out, and b
      // — a's dependant — with it: b restores AFTER a, as the note measured
      // under the graph-wide rule. Both stay in probe reuse.
      await addProject(fixture.root, 'a', {
        files: { 'src/a.txt': 'a' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "mkdir -p dist && echo a > dist/a.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'b', {
        files: { 'src/b.txt': 'b' },
        deps: { a: '*' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^build'],
                exec: { command: "echo b > ../a/dist/b.txt" },
                cache: { inputs: { files: ['src/**'], tasks: [] }, outputs: { files: [], workspaceFiles: ['packages/a/dist/b.txt'] } },
              },
            },
          }
        `,
      })
      const cold = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(cold.ok).toBe(true)
      const c = await classify(fixture, ['build'])
      expect(c.preProbedIds.has('a#build')).toBe(true)
      expect(c.preProbedIds.has('b#build')).toBe(true)
      expect(c.restoreTier.has('a#build')).toBe(false)
      expect(c.restoreTier.has('b#build')).toBe(false)
    },
    TIMEOUT,
  )

  it(
    '--no-cache: no short-circuit (localRead off); behavior unchanged',
    async () => {
      await addProject(fixture.root, 'nc', {
        files: { 'src/a.txt': 'a' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
              top: {
                dependsOn: ['build'],
                exec: { command: 'true' },
              },
            },
          }
        `,
      })
      // Warm the cache.
      await run({ cwd: fixture.root, tasks: ['top'], log: silentLogger(fixture) })

      // With --no-cache the short-circuit must not even probe: spy on
      // Cache.get and assert it's never called (localRead off → no read).
      const getSpy = spyOn(Cache.prototype, 'get')
      const res = await run({
        cwd: fixture.root,
        tasks: ['top'],
        cache: { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false },
        log: silentLogger(fixture),
      })
      expect(res.ok).toBe(true)
      // build re-executed (no read), reported success not cache-hit.
      expect(res.outcomes.find((o) => o.node.id === 'nc#build')?.status).toBe('success')
      expect(getSpy).toHaveBeenCalledTimes(0)
      getSpy.mockRestore()
    },
    TIMEOUT,
  )

  it(
    'no double-probe: each cacheable task is probed exactly once on a warm run',
    async () => {
      await addProject(fixture.root, 'dp-lib', {
        files: { 'src/a.txt': 'a', '.gitignore': 'dist/\n' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "mkdir -p dist && echo x > dist/o.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'dp-app', {
        deps: { 'dp-lib': 'workspace:*' },
        files: { 'src/b.txt': 'b', '.gitignore': 'dist/\n' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^build'],
                exec: { command: "mkdir -p dist && echo y > dist/o.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })

      // Cold populates the cache.
      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })

      // Warm: count the probes. Two cacheable tasks → ONE batched probe
      // carrying both hashes (the up-front classify) and no per-task
      // `get` at all (execute() reuses the batch's answers).
      const getSpy = spyOn(Cache.prototype, 'get')
      const getManySpy = spyOn(Cache.prototype, 'getMany')
      try {
        const warm = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        expect(warm.ok).toBe(true)
        expect(
          warm.outcomes.every((o) => o.node.config.exec === undefined || o.status === 'cache-hit'),
        ).toBe(true)
        expect(getManySpy).toHaveBeenCalledTimes(1)
        expect(getManySpy.mock.calls[0]![0]).toHaveLength(2)
        expect(getSpy).toHaveBeenCalledTimes(0)
      } finally {
        // A leaked prototype spy poisons every later file in the process.
        getSpy.mockRestore()
        getManySpy.mockRestore()
      }
    },
    TIMEOUT,
  )

  it(
    'restore-tier dependent reports cache-hit even when its dep FAILS (deterministic)',
    async () => {
      // up#prep is a NON-cacheable task that always fails. down#build
      // depends on it (ordering) but decouples its key (`inputs.tasks:
      // []`), so down's key is unchanged by prep — on a warm run it's a
      // stable cross-project hit (restore-tier). down#build is
      // dep-independent + key-independent of up's success, so it reports
      // cache-hit; the run overall still exits non-zero (up failed).
      await addProject(fixture.root, 'fprep', {
        files: { 'src/a.txt': 'a' },
        config: `
          export default {
            tasks: {
              prep: {
                exec: { command: 'exit 1' },
              },
            },
          }
        `,
      })
      const downDir = await addProject(fixture.root, 'fapp', {
        deps: { fprep: 'workspace:*' },
        files: { 'src/b.txt': 'b', '.gitignore': 'dist/\n' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^prep'],
                exec: { command: "mkdir -p dist && echo built > dist/o.txt" },
                cache: { inputs: { files: ['src/**'], tasks: [] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })

      // Cold: run ONLY down#build (no deps) so its hit gets cached
      // without prep failing the cold run. `inputs.tasks: []` decouples
      // its key, so the hash is identical with or without prep in graph.
      const cold = await run({
        cwd: fixture.root,
        tasks: ['fapp#build'],
        excludeDependencies: 'all',
        log: silentLogger(fixture),
      })
      expect(cold.ok).toBe(true)

      // Wipe down's output so a restore is observable, then run the
      // group (prep + down). prep fails; down is a restore-tier hit.
      await rm(path.join(downDir, 'dist'), { recursive: true, force: true })

      // Run several times — the restore-tier outcome must be stable.
      for (let i = 0; i < 4; i++) {
        const res = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        expect(res.ok).toBe(false) // prep failed
        expect(res.outcomes.find((o) => o.node.id === 'fprep#prep')?.status).toBe('failed')
        expect(res.outcomes.find((o) => o.node.id === 'fapp#build')?.status).toBe('cache-hit')
      }
    },
    TIMEOUT,
  )

  it(
    'flat graph (no deps): classified through ONE batched probe, still correct',
    async () => {
      await addProject(fixture.root, 'flat', {
        files: { 'src/a.txt': 'a' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: "node -e 'process.stdout.write(String(Date.now()))' > out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      const c = await classify(fixture, ['build'])
      expect(c.restoreTier.has('flat#build')).toBe(true)
      // A flat graph has no ordering to bypass, but it still classifies: the
      // one batched `getMany` replaces a `cache.get` per task inside the run
      // (measured 2026-09-03: 84 → 78 ms on 100 dep-free tasks).
      const getSpy = spyOn(Cache.prototype, 'get')
      const getManySpy = spyOn(Cache.prototype, 'getMany')
      try {
        const warm = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
        expect(warm.outcomes.find((o) => o.node.id === 'flat#build')?.status).toBe('cache-hit')
        expect(getManySpy).toHaveBeenCalledTimes(1)
        expect(getSpy).toHaveBeenCalledTimes(0)
      } finally {
        getSpy.mockRestore()
        getManySpy.mockRestore()
      }
    },
    TIMEOUT,
  )

  it('gate: LayeredCache runs never classify — remote-prefetch owns those', async () => {
    // Under a LayeredCache, cache.get is a remote READ-THROUGH and the
    // up-front classify is awaited before scheduling — N remote GETs
    // would land on the critical path. The gate must decline so remote
    // runs stay on the fire-and-forget prefetch path (decision log
    // 2026-06-28).
    const nodes = new Map([
      ['a#build', { id: 'a#build', deps: [] }],
      ['a#test', { id: 'a#test', deps: ['a#build'] }],
    ]) as never
    const local = new Cache(path.join(fixture.root, '.vx', 'cache'))
    const stubRemote: RemoteCacheLayer = {
      has: () => Promise.resolve(false),
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    }
    try {
      const layered = new LayeredCache(local, stubRemote)
      expect(shouldShortCircuit(nodes, FULL_CACHE_POLICY, layered)).toBe(false)
      // Identical graph + policy with a plain local Cache → gate opens.
      expect(shouldShortCircuit(nodes, FULL_CACHE_POLICY, local)).toBe(true)
    } finally {
      local.close()
    }
  })
})
