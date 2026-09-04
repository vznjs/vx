// `--download` phase 1: the deferral eligibility gate, the plan-time mode
// decision, and the deferred/materialise/converge lifecycle end to end
// through a real `run()` with a fake remote executor.
//
// See docs/design/download-policy-cas-cache-2026-08.md §14.

import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { planRun, run } from '../src/index.js'
import { formatPlanJson, formatPlanText } from '../src/cli/plan-format.js'
import { deferralEligibility, resolveDownloadModes } from '../src/orchestrator/download-policy.js'
import type { TaskNode } from '../src/graph/index.js'

// ── unit: the eligibility gate ──────────────────────────────────────

function node(id: string, cache?: unknown, deps: string[] = []): TaskNode {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    id,
    projectName,
    taskName,
    projectDir: `/ws/${projectName}`,
    deps,
    config: { exec: { command: 'true' }, ...(cache === undefined ? {} : { cache }) },
  } as unknown as TaskNode
}

const graph = (...ns: TaskNode[]): Map<string, TaskNode> => new Map(ns.map((n) => [n.id, n]))

describe('deferralEligibility', () => {
  it('a disjoint-prefix sibling does NOT force the producer eager', () => {
    // The shape every real workspace has: `test` reads src/**, `build`
    // writes dist/**. The coarse "same project" rule would mark build
    // ineligible and leave --download=none with nothing to defer.
    const nodes = graph(
      node('a#build', { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
      node('a#test', { inputs: { files: ['src/**'] }, outputs: { files: [] } }),
    )
    expect(deferralEligibility(nodes).has('a#build')).toBe(false)
  })

  it('an OVERLAPPING same-project reader forces the producer eager', () => {
    // The false-positive control's twin: here the consumer really can read
    // the producer's outputs, so the key could move with deferral.
    const nodes = graph(
      node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] } }),
      node('a#build', { inputs: { files: ['gen/**'] }, outputs: { files: ['dist/**'] } }),
    )
    const out = deferralEligibility(nodes)
    expect(out.get('a#gen')).toContain('a#build reads gen')
    expect(out.has('a#build')).toBe(false)
  })

  it('a leading wildcard reads everything, so it forces eager', () => {
    const nodes = graph(
      node('a#build', { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
      node('a#lint', { inputs: { files: ['**/*.ts'] }, outputs: { files: [] } }),
    )
    expect(deferralEligibility(nodes).get('a#build')).toContain('the whole project')
  })

  it('workspaceFiles on either side forces eager', () => {
    const wsOut = graph(
      node('a#gen', {
        inputs: { files: ['src/**'] },
        outputs: { files: [], workspaceFiles: ['g/**'] },
      }),
    )
    expect(deferralEligibility(wsOut).get('a#gen')).toContain('outputs.workspaceFiles')
    const wsIn = graph(
      node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
      node('b#use', {
        inputs: { files: ['src/**'], workspaceFiles: ['a/dist/**'] },
        outputs: { files: [] },
      }),
    )
    expect(deferralEligibility(wsIn).get('a#gen')).toContain('inputs.workspaceFiles')
  })

  it('a runtime-command reader forces eager — its reads cannot be bounded', () => {
    // The hole the first cut had: the gate compared GLOBS, but a
    // `cache.inputs.runtime` command is a shell command that can `cat` the
    // producer's outputs, and its stdout is folded into the key. Deferral
    // sharpens it further by skipping the output clean, so a stale prior
    // build is exactly what such a command would sample.
    const nodes = graph(
      node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } }),
      node('a#use', {
        inputs: { files: ['src/**'], runtime: [{ command: 'cat out/gen.txt' }] },
        outputs: { files: ['dist/**'] },
      }),
    )
    expect(deferralEligibility(nodes).get('a#gen')).toContain('cache.inputs.runtime')
  })

  it('a workspaceRuntime reader does the same, across projects', () => {
    const nodes = graph(
      node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } }),
      node('b#use', {
        inputs: { files: ['src/**'], workspaceRuntime: [{ command: 'cat a/out/gen.txt' }] },
        outputs: { files: ['dist/**'] },
      }),
    )
    expect(deferralEligibility(nodes).has('a#gen')).toBe(true)
  })

  it('CONTROL: a run with no runtime inputs still defers', () => {
    // Without this the fix above could degenerate into "refuse everything".
    const nodes = graph(
      node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } }),
      node('a#use', { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
    )
    expect(deferralEligibility(nodes).has('a#gen')).toBe(false)
  })

  it('project boundaries hold: a different project cannot force it eager', () => {
    const nodes = graph(
      node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] } }),
      node('b#build', { inputs: { files: ['gen/**'] }, outputs: { files: ['dist/**'] } }),
    )
    expect(deferralEligibility(nodes).has('a#gen')).toBe(false)
  })
})

describe('resolveDownloadModes', () => {
  const nodes = graph(
    node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
    node('a#local', { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } }),
  )

  it('policy `all` keeps every task eager — the byte-identical default', () => {
    const r = resolveDownloadModes({
      nodes,
      policy: 'all',
      localPlaced: new Set(),
      remoteOnly: new Set(),
    })
    expect([...r.modeOf.values()]).toEqual(['eager', 'eager'])
    expect(r.downgrades.size).toBe(0)
  })

  it('policy `none` defers remote-placed eligible tasks only', () => {
    const r = resolveDownloadModes({
      nodes,
      policy: 'none',
      localPlaced: new Set(['a#local']),
      remoteOnly: new Set(),
    })
    expect(r.modeOf.get('a#gen')).toBe('deferred')
    expect(r.modeOf.get('a#local')).toBe('eager')
  })

  it('policy `toplevel` keeps the REQUESTED tasks eager and defers the rest', () => {
    const requested = graph(
      {
        ...node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
        requested: false,
      } as TaskNode,
      {
        ...node('a#ship', { inputs: { files: ['src/**'] }, outputs: { files: ['pkg/**'] } }),
        requested: true,
      } as TaskNode,
    )
    const r = resolveDownloadModes({
      nodes: requested,
      policy: 'toplevel',
      localPlaced: new Set(),
      remoteOnly: new Set(),
    })
    expect(r.modeOf.get('a#ship')).toBe('eager')
    expect(r.modeOf.get('a#gen')).toBe('deferred')
  })

  it("`toplevel` treats a requested GROUP's surfaced tasks as asked-for", () => {
    // A group has no outputs of its own; `markSurfacedDeps` marks the real
    // tasks it chains. Keying on `requested` alone meant `vx run ci
    // --download=toplevel` deferred everything and brought home nothing —
    // the one outcome the mode exists to avoid.
    const nodes3 = graph(
      {
        ...node('a#build', { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }),
        requested: false,
        surfaced: true,
      } as TaskNode,
      {
        ...node('b#dep', { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } }),
        requested: false,
      } as TaskNode,
    )
    const r = resolveDownloadModes({
      nodes: nodes3,
      policy: 'toplevel',
      localPlaced: new Set(),
      remoteOnly: new Set(),
    })
    expect(r.modeOf.get('a#build')).toBe('eager')
    // …and a plain intermediate still defers, so this is not "everything eager".
    expect(r.modeOf.get('b#dep')).toBe('deferred')
  })

  it('`toplevel` still honours the eligibility gate for the rest', () => {
    // A requested task is eager because it was asked for; an intermediate
    // whose outputs another key can read is eager because it MUST be.
    const nodes2 = graph(
      {
        ...node('a#gen', { inputs: { files: ['src/**'] }, outputs: { files: ['gen/**'] } }),
        requested: false,
      } as TaskNode,
      {
        ...node('a#build', { inputs: { files: ['gen/**'] }, outputs: { files: ['dist/**'] } }),
        requested: true,
      } as TaskNode,
    )
    const r = resolveDownloadModes({
      nodes: nodes2,
      policy: 'toplevel',
      localPlaced: new Set(),
      remoteOnly: new Set(),
    })
    expect(r.modeOf.get('a#gen')).toBe('eager')
    expect(r.downgrades.get('a#gen')).toContain('a#build reads gen')
  })

  it("`remote: 'only'` stays never — --download cannot override it", () => {
    const r = resolveDownloadModes({
      nodes,
      policy: 'none',
      localPlaced: new Set(),
      remoteOnly: new Set(['a#gen']),
    })
    expect(r.modeOf.get('a#gen')).toBe('never')
  })
})

// ── e2e: a real run() with a fake remote executor ───────────────────

const silent = (): NonNullable<Parameters<typeof run>[0]['log']> =>
  ({ status: () => undefined, error: () => undefined }) as unknown as NonNullable<
    Parameters<typeof run>[0]['log']
  >

interface Fake {
  executed: string[]
  materialized: string[]
  failMaterialize?: boolean
  failProducer?: boolean
}

/**
 * pkg-a#gen runs on a fake REMOTE executor and writes `out/gen.txt`;
 * pkg-b#use runs LOCALLY and cats that file. Cross-project, so the
 * eligibility gate leaves `gen` deferrable.
 */
async function fixture(
  opts: { consumers?: number; failMaterialize?: boolean; failProducer?: boolean } = {},
): Promise<{
  root: string
  cleanup: () => void
}> {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-download-'))
  await Bun.write(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }))
  await Bun.write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await mkdir(path.join(root, 'packages', 'pkg-a', 'src'), { recursive: true })
  await Bun.write(
    path.join(root, 'packages', 'pkg-a', 'package.json'),
    JSON.stringify({ name: 'pkg-a', version: '0.0.0' }),
  )
  await Bun.write(path.join(root, 'packages', 'pkg-a', 'src', 'in.txt'), 'seed\n')
  await Bun.write(
    path.join(root, 'packages', 'pkg-a', 'vx.config.mjs'),
    `export default { tasks: {
       gen: {
         exec: { command: 'true' },
         cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } },
       },
     } }`,
  )
  const consumers = opts.consumers ?? 1
  for (let i = 0; i < consumers; i++) {
    const name = `pkg-b${i === 0 ? '' : i}`
    await mkdir(path.join(root, 'packages', name, 'src'), { recursive: true })
    await Bun.write(
      path.join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name, version: '0.0.0', dependencies: { 'pkg-a': 'workspace:*' } }),
    )
    await Bun.write(path.join(root, 'packages', name, 'src', 'x.txt'), 'x\n')
    await Bun.write(
      path.join(root, 'packages', name, 'vx.config.mjs'),
      `export default { tasks: {
         use: {
           exec: { command: 'cat ../pkg-a/out/gen.txt > used.txt' },
           dependsOn: ['^gen'],
           cache: { inputs: { files: ['src/**'] }, outputs: { files: ['used.txt'] } },
         },
       } }`,
    )
  }
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([
      `{
         name: 'org/fake-remote',
         executor() {
           return {
             name: 'fake-remote',
             remote: true,
             accepts: (t) => t.taskId.endsWith('#gen'),
             async execute(req) {
               const fake = (globalThis.__vxDownload ??= { executed: [], materialized: [] })
               fake.executed.push(req.taskId)
               const write = async () => {
                 const { mkdir } = await import('node:fs/promises')
                 const p = await import('node:path')
                 await mkdir(p.join(req.cwd, 'out'), { recursive: true })
                 await Bun.write(p.join(req.cwd, 'out', 'gen.txt'), 'GENERATED')
               }
               if (fake.failProducer === true) {
                 return { exitCode: 7, durationMs: 1, stdout: '', stderr: 'boom', violations: [] }
               }
               const base = { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
               if (req.download === 'deferred') {
                 return { ...base, outputs: { kind: 'deferred', materialize: async () => {
                   fake.materialized.push(req.taskId)
                   if (fake.failMaterialize === true) throw new Error('blob evicted from CAS')
                   await write()
                 } } }
               }
               await write()
               return base
             },
           }
         },
       }`,
    ]),
  )
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
  const g = globalThis as unknown as { __vxDownload?: Fake }
  g.__vxDownload = {
    executed: [],
    materialized: [],
    ...(opts.failMaterialize === true ? { failMaterialize: true } : {}),
    ...(opts.failProducer === true ? { failProducer: true } : {}),
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const fake = (): Fake => (globalThis as unknown as { __vxDownload: Fake }).__vxDownload

describe('--download end to end', () => {
  it('key identity: all and none derive byte-identical keys', async () => {
    const a = await fixture()
    try {
      const eager = await run({
        cwd: a.root,
        tasks: ['gen'],
        projects: ['pkg-a'],
        log: silent(),
        handleSignals: false,
      })
      const deferred = await run({
        cwd: a.root,
        tasks: ['gen'],
        projects: ['pkg-a'],
        download: 'none',
        cache: { localRead: false, localWrite: true, remoteRead: false, remoteWrite: true },
        log: silent(),
        handleSignals: false,
      })
      expect(eager.outcomes[0]!.hash).toBe(deferred.outcomes[0]!.hash)
      expect(deferred.outcomes[0]!.outputs).toBe('deferred')
    } finally {
      a.cleanup()
    }
  })

  it('a deferred task writes NO local entry, and leaves the tree alone', async () => {
    const a = await fixture()
    try {
      const stale = path.join(a.root, 'packages', 'pkg-a', 'out', 'gen.txt')
      await mkdir(path.dirname(stale), { recursive: true })
      await writeFile(stale, 'STALE')
      const r = await run({
        cwd: a.root,
        tasks: ['gen'],
        projects: ['pkg-a'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      expect(fake().materialized).toEqual([])
      // never-clean: the deferred task did not wipe what was there.
      expect(await readFile(stale, 'utf8')).toBe('STALE')
      // A second run must MISS (no entry was written), not hit.
      const again = await run({
        cwd: a.root,
        tasks: ['gen'],
        projects: ['pkg-a'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      expect(again.outcomes[0]!.status).toBe('success')
      expect(fake().executed.length).toBe(2)
    } finally {
      a.cleanup()
    }
  })

  it('a local consumer materialises its producer lazily, then converges to a local entry', async () => {
    const a = await fixture()
    try {
      const r = await run({
        cwd: a.root,
        tasks: ['use'],
        projects: ['pkg-b'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      expect(fake().materialized).toEqual(['pkg-a#gen'])
      // The consumer's command actually read the bytes.
      expect(await readFile(path.join(a.root, 'packages', 'pkg-b', 'used.txt'), 'utf8')).toBe(
        'GENERATED',
      )
      // Convergence: the producer now has an ordinary entry, so a fresh
      // run hits locally and never reaches the executor again.
      const before = fake().executed.length
      const second = await run({
        cwd: a.root,
        tasks: ['gen'],
        projects: ['pkg-a'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      expect(second.outcomes[0]!.status).toBe('cache-hit')
      expect(fake().executed.length).toBe(before)
    } finally {
      a.cleanup()
    }
  })

  it('two consumers share ONE materialisation', async () => {
    const a = await fixture({ consumers: 2 })
    try {
      const r = await run({
        cwd: a.root,
        tasks: ['use'],
        projects: ['pkg-b', 'pkg-b1'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      expect(fake().materialized).toEqual(['pkg-a#gen'])
    } finally {
      a.cleanup()
    }
  })

  it('a failed materialisation fails the CONSUMER, naming the producer', async () => {
    const a = await fixture({ failMaterialize: true })
    try {
      const r = await run({
        cwd: a.root,
        tasks: ['use'],
        projects: ['pkg-b'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      expect(r.ok).toBe(false)
      const producer = r.outcomes.find((o) => o.node.id === 'pkg-a#gen')!
      const consumer = r.outcomes.find((o) => o.node.id === 'pkg-b#use')!
      expect(producer.status).toBe('success')
      expect(consumer.status).toBe('failed')
    } finally {
      a.cleanup()
    }
  })

  it('--dry SHOWS what would stay remote and why anything was kept eager', async () => {
    // The gate downgrades silently, so without this surface a user who asks
    // for --download=none and gets no deferral has nothing to read. Phase 1
    // claimed the --dry surface and shipped without it; this is the pin that
    // would have caught that.
    const a = await fixture()
    try {
      const plan = await planRun({
        cwd: a.root,
        tasks: ['gen'],
        projects: ['pkg-a'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      const gen = plan.tasks.find((t) => t.node.id === 'pkg-a#gen')
      expect(gen?.download).toBe('deferred')
      const text = formatPlanText(plan)
      expect(text).toContain('would keep outputs remote')

      // …and the downgrade path names the reason rather than staying silent.
      await Bun.write(
        path.join(a.root, 'packages', 'pkg-a', 'vx.config.mjs'),
        `export default { tasks: {
           gen: {
             exec: { command: 'true' },
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } },
           },
           reader: {
             exec: { command: 'true' },
             cache: { inputs: { files: ['out/**'] }, outputs: { files: ['d/**'] } },
           },
         } }`,
      )
      // BOTH tasks must be in the run graph: the gate asks whether any key
      // IN THIS RUN could observe the producer, and a task nobody requested
      // computes no key here (the design's cross-run residual — an
      // undeclared reader is outside the contract either way).
      const plan2 = await planRun({
        cwd: a.root,
        tasks: ['gen', 'reader'],
        projects: ['pkg-a'],
        download: 'none',
        log: silent(),
        handleSignals: false,
      })
      expect(plan2.downloadDowngrades?.some((d) => d.taskId === 'pkg-a#gen')).toBe(true)
      expect(formatPlanText(plan2)).toContain('kept eager')
    } finally {
      a.cleanup()
    }
  })

  it('the JSON plan carries the download decision and the refusals', async () => {
    // The scripting surface. `formatPlanJson` enumerates its fields, so a
    // new PlannedTask field does NOT appear there for free — the text plan
    // and the JSON plan are separate promises and both have to be kept.
    const a = await fixture()
    try {
      await Bun.write(
        path.join(a.root, 'packages', 'pkg-a', 'vx.config.mjs'),
        `export default { tasks: {
           gen: {
             exec: { command: 'true' },
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } },
           },
           reader: {
             exec: { command: 'true' },
             cache: { inputs: { files: ['out/**'] }, outputs: { files: ['d/**'] } },
           },
         } }`,
      )
      const withDowngrade = JSON.parse(
        formatPlanJson(
          await planRun({
            cwd: a.root,
            tasks: ['gen', 'reader'],
            projects: ['pkg-a'],
            download: 'none',
            log: silent(),
            handleSignals: false,
          }),
        ),
      ) as { downloadDowngrades?: Array<{ taskId: string; reason: string }> }
      expect(withDowngrade.downloadDowngrades?.some((d) => d.taskId === 'pkg-a#gen')).toBe(true)

      // …and a deferring task carries the per-task field. `gen` is the one
      // the fake REMOTE executor accepts — `reader` falls to the local
      // executor and is eager by placement, which is correct and would make
      // this assertion prove nothing.
      const deferring = JSON.parse(
        formatPlanJson(
          await planRun({
            cwd: a.root,
            tasks: ['gen'],
            projects: ['pkg-a'],
            download: 'none',
            log: silent(),
            handleSignals: false,
          }),
        ),
      ) as { tasks: Array<{ id: string; download?: string }> }
      expect(deferring.tasks.find((t) => t.id === 'pkg-a#gen')?.download).toBe('deferred')
    } finally {
      a.cleanup()
    }
  })

  it('a failed materialisation still reports the producer as left-remote', async () => {
    // The entry is cleared only on SUCCESS, so a failed fetch must still
    // appear in the run's "left outputs remote" line — that is exactly when
    // the user needs telling that the tree is not current.
    const a = await fixture({ failMaterialize: true })
    try {
      const lines: string[] = []
      const r = await run({
        cwd: a.root,
        tasks: ['use'],
        projects: ['pkg-b'],
        download: 'none',
        log: {
          status: (l: string) => lines.push(l),
          error: () => undefined,
        } as unknown as NonNullable<Parameters<typeof run>[0]['log']>,
        handleSignals: false,
      })
      expect(r.ok).toBe(false)
      expect(lines.some((l) => l.includes('left outputs remote') && l.includes('pkg-a#gen'))).toBe(
        true,
      )
    } finally {
      a.cleanup()
    }
  })

  it('a materialisation failure trips --continue=never like any other failure', async () => {
    const a = await fixture({ consumers: 2, failMaterialize: true })
    try {
      const r = await run({
        cwd: a.root,
        tasks: ['use'],
        projects: ['pkg-b', 'pkg-b1'],
        download: 'none',
        continueMode: 'never',
        // Strict ordering, as the scheduler's own fail-fast pins use: with
        // both consumers in flight at once they would BOTH legitimately
        // fail (fail-fast stops queued dispatch, in-flight work finishes),
        // which proves nothing about the trip.
        concurrency: 1,
        log: silent(),
        handleSignals: false,
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes.find((o) => o.node.id === 'pkg-a#gen')!.status).toBe('success')
      const consumerStatuses = r.outcomes
        .filter((o) => o.node.taskName === 'use')
        .map((o) => o.status)
      // One consumer failed on the fetch; the queued one never dispatched.
      expect(consumerStatuses.filter((st) => st === 'failed').length).toBe(1)
      expect(consumerStatuses.filter((st) => st === 'skipped').length).toBe(1)
    } finally {
      a.cleanup()
    }
  })

  it('--continue=always with a FAILED deferred producer does not wedge its dependent', async () => {
    // Registration happens only on a zero exit, so a failed producer leaves
    // NO registry entry — and `--continue=always` runs the dependent anyway.
    // It must materialise nothing, run, and fail on its own missing input,
    // rather than hanging or throwing out of the registry walk. The path
    // exists because the two features were built three waves apart and had
    // never met.
    const a = await fixture({ failProducer: true })
    try {
      const r = await run({
        cwd: a.root,
        tasks: ['use'],
        projects: ['pkg-b'],
        download: 'none',
        continueMode: 'always',
        log: silent(),
        handleSignals: false,
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes.find((o) => o.node.id === 'pkg-a#gen')!.status).toBe('failed')
      // The dependent RAN (not skipped — that is what `always` means) and
      // failed on its own, with nothing materialised.
      expect(r.outcomes.find((o) => o.node.id === 'pkg-b#use')!.status).toBe('failed')
      expect(fake().materialized).toEqual([])
    } finally {
      a.cleanup()
    }
  })

  it('--download=all is unchanged: outputs land eagerly, entry saved, no deferral', async () => {
    const a = await fixture()
    try {
      const r = await run({
        cwd: a.root,
        tasks: ['gen'],
        projects: ['pkg-a'],
        log: silent(),
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.outputs).toBeUndefined()
      expect(fake().materialized).toEqual([])
      expect(await readFile(path.join(a.root, 'packages', 'pkg-a', 'out', 'gen.txt'), 'utf8')).toBe(
        'GENERATED',
      )
    } finally {
      a.cleanup()
    }
  })
})
