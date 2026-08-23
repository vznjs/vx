// Direct tests for `computeTaskHash` — the function that derives EVERY cache
// key vx produces. `tests/task-hash.test.ts` covers only `computeGroupHash`;
// the derivation itself was reachable only through end-to-end orchestrator
// runs, which exercise it but pin none of its contracts.
//
// Why that matters here specifically: a wrong key is this project's worst
// failure class. It does not throw, it does not fail a run, it silently
// replays a stale artifact and reports `up-to-date` — the decision log records
// eight separate stale-hit defects, and every one of them routes through this
// function. So the assertions below are deliberately split into two kinds, and
// both directions are load-bearing:
//
//   SENSITIVITY — an input changed, so the key MUST move. Missing sensitivity
//   is a stale hit: vx serves yesterday's bytes for today's source.
//
//   STABILITY — something changed that provably cannot affect a task's output,
//   so the key MUST NOT move. Missing stability is a cache that never hits,
//   which is a performance bug that reads as "caching doesn't work".
//
// Several of these encode decisions the log says would cost a CACHE_VERSION
// bump to reverse. Those are marked; they exist so a future refactor has to
// argue with a failing test rather than silently changing what a key means.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import type { CacheLayer } from '../src/cache/index.js'
import { computeTaskHash } from '../src/orchestrator/task-hash.js'
import { createHashCache } from '../src/orchestrator/task-hash.js'
import type { TaskConfig } from '../src/config.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'

// The fixture creates a real SQLite cache; under full-suite load the default
// 5s hook budget is tight. File-scoped, matching tests/inputs.test.ts.
setDefaultTimeout(30_000)

let root: string
let cache: Cache

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-taskhash-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'pkg' }))
  // vx defers to git for the input file set, so any task declaring a non-empty
  // glob needs a real work tree — without one, `resolveFiles` raises a
  // UserError rather than degrading.
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  cache = new Cache(path.join(root, '.vx-cache'))
})

afterAll(async () => {
  cache.close()
  await rm(root, { recursive: true, force: true })
})

/**
 * A task with NO file inputs. `resolveFiles` returns early on an empty
 * positive-glob list, so this path never spawns git — which keeps the
 * derivation contracts below hermetic and fast. The file-input contracts that
 * genuinely need git live in their own block at the bottom.
 */
function node(over: Partial<TaskNode> = {}, cfgOver: Partial<TaskConfig> = {}): TaskNode {
  const config: TaskConfig = {
    exec: { command: 'build' },
    cache: { inputs: { files: [] }, outputs: { files: [] } },
    ...cfgOver,
  }
  return {
    id: 'pkg#build',
    projectName: 'pkg',
    projectDir: root,
    taskName: 'build',
    config,
    deps: [],
    requested: false,
    ...over,
  }
}

function outcome(id: string, hash: string): TaskOutcome {
  const [projectName, taskName] = id.split('#') as [string, string]
  return {
    node: {
      id,
      projectName,
      projectDir: root,
      taskName,
      config: { exec: { command: 'noop' } },
      deps: [],
      requested: false,
    },
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    hash,
  }
}

interface KeyArgs {
  node?: TaskNode
  upstream?: TaskOutcome[]
  forwardArgs?: readonly string[]
  cache?: CacheLayer
  hashCache?: ReturnType<typeof createHashCache>
  workspaceFingerprint?: string
}

async function key(a: KeyArgs = {}): Promise<string> {
  return await computeTaskHash({
    node: a.node ?? node(),
    upstream: a.upstream ?? [],
    workspaceRoot: root,
    workspaceFingerprint: a.workspaceFingerprint ?? 'ws-fp',
    cache: a.cache ?? cache,
    nestedProjectDirs: [],
    ...(a.forwardArgs !== undefined ? { forwardArgs: a.forwardArgs } : {}),
    ...(a.hashCache !== undefined ? { hashCache: a.hashCache } : {}),
  })
}

describe('computeTaskHash — determinism', () => {
  it('is a pure function of its inputs: same inputs, same key', async () => {
    // The floor everything else stands on. If this ever flakes, no other
    // assertion in this file means anything.
    expect(await key()).toBe(await key())
  })

  it('a different task id yields a different key', async () => {
    // Two tasks with byte-identical config must not share an artifact — they
    // run different commands' worth of work under the same project.
    const a = await key({ node: node({ id: 'pkg#build' }) })
    const b = await key({ node: node({ id: 'pkg#test' }) })
    expect(a).not.toBe(b)
  })

  it('the workspace fingerprint folds in — a lockfile bump invalidates everything', async () => {
    // This is the mechanism by which a dependency upgrade reaches tasks whose
    // own inputs did not change. Without it, `pnpm up` leaves every task warm
    // against binaries built from the old dependency tree.
    expect(await key({ workspaceFingerprint: 'a' })).not.toBe(
      await key({ workspaceFingerprint: 'b' }),
    )
  })
})

describe('computeTaskHash — what the config contributes', () => {
  it('the command folds in', async () => {
    const a = await key({ node: node({}, { exec: { command: 'build' } }) })
    const b = await key({ node: node({}, { exec: { command: 'build --prod' } }) })
    expect(a).not.toBe(b)
  })

  it('STABILITY: adding exec.resources does NOT move the key', async () => {
    // `hashableConfig` strips `exec.resources` before stringifying. Resources
    // are a scheduling ADMISSION hint — how many CPU/memory units a task
    // reserves so the scheduler can pack the run. Nothing about them reaches
    // the task's output, so tuning a reservation must never cost a full
    // rebuild. The log records this as the reason the field shipped with NO
    // CACHE_VERSION bump: a config declaring none stringifies byte-identically
    // to before the field existed.
    const plain = await key({ node: node({}, { exec: { command: 'build' } }) })
    const reserved = await key({
      node: node({}, { exec: { command: 'build', resources: { cpus: 2 } } }),
    })
    expect(reserved).toBe(plain)
  })

  it('STABILITY: changing exec.resources does NOT move the key', async () => {
    // The half that actually bites a user: they tune a reservation up on a
    // slow machine, and the whole graph must stay warm.
    const two = await key({
      node: node({}, { exec: { command: 'build', resources: { cpus: 2 } } }),
    })
    const eight = await key({
      node: node({}, { exec: { command: 'build', resources: { cpus: 8, memory: '2GB' } } }),
    })
    expect(eight).toBe(two)
  })

  it('STABILITY: exec.remote does NOT move the key', async () => {
    // Placement, not content. `exec.remote: false` says "run this task on
    // this machine" — it never reaches the task's output, and the whole
    // contract of a remote executor is that the same command over the same
    // inputs produces the same bytes wherever it runs. A key that moved when
    // placement changed would split a laptop from a worker pool over nothing
    // and gut the remote hit rate, which is the same argument that strips
    // `exec.resources` one test up.
    const plain = await key({ node: node({}, { exec: { command: 'build' } }) })
    const pinned = await key({ node: node({}, { exec: { command: 'build', remote: false } }) })
    const shipped = await key({ node: node({}, { exec: { command: 'build', remote: true } }) })
    expect(pinned).toBe(plain)
    expect(shipped).toBe(plain)
  })

  it('STABILITY: stripping remote leaves the REST of exec folded', async () => {
    // The control for the strip: `hashableConfig` rebuilds `exec` without
    // `remote`, so a bug that dropped a sibling field with it would make two
    // genuinely different tasks share a key. This fails if the strip is too
    // wide.
    const a = await key({
      node: node({}, { exec: { command: 'build', remote: false, timeout: 5_000 } }),
    })
    const b = await key({
      node: node({}, { exec: { command: 'build', remote: false, timeout: 9_000 } }),
    })
    expect(b).not.toBe(a)
  })

  it('SENSITIVITY: exec.timeout DOES move the key — distinct by design', async () => {
    // The anti-drift pin for the neighbouring decision. `timeout` and
    // `retries` sit right beside `resources` in the same object and are NOT
    // stripped: the log states that retro-stripping them would change every
    // affected key and therefore require a CACHE_VERSION bump, so it was
    // deliberately left out of scope. Someone who reads the `resources` strip
    // and reasonably concludes "these are all scheduling hints, strip them
    // too" has to fail this test first.
    const a = await key({ node: node({}, { exec: { command: 'build' } }) })
    const b = await key({ node: node({}, { exec: { command: 'build', timeout: 5_000 } }) })
    expect(b).not.toBe(a)
  })

  it('SENSITIVITY: exec.retries DOES move the key — distinct by design', async () => {
    const a = await key({ node: node({}, { exec: { command: 'build' } }) })
    const b = await key({ node: node({}, { exec: { command: 'build', retries: 2 } }) })
    expect(b).not.toBe(a)
  })

  it('a declared input glob folds in even when it resolves to nothing', async () => {
    // Resolved-config hashing: the DECLARATION participates, not only what it
    // matched. So narrowing `files` from `['src/**']` to `[]` is a key change
    // even in a project with no `src/` — which is what stops a user's
    // narrowing edit from silently reusing the broader run's artifact.
    const wide = await key({
      node: node({}, { cache: { inputs: { files: ['nope/**'] }, outputs: { files: [] } } }),
    })
    const narrow = await key({
      node: node({}, { cache: { inputs: { files: [] }, outputs: { files: [] } } }),
    })
    expect(wide).not.toBe(narrow)
  })
})

describe('computeTaskHash — forwardArgs are scoped to REQUESTED tasks', () => {
  // `vx run test -- --watch` must apply the trailing args to `test` and to
  // nothing else. Before the 2026-05 fix they leaked into every task
  // `dependsOn` pulled in, which polluted those tasks' cache keys: the same
  // `build` derived a different key depending on what the user typed after
  // `--` for a DOWNSTREAM task. That is a cache that misses for no reason, on
  // an invocation the user believes is identical.

  it('a requested task folds forwardArgs into its key', async () => {
    const bare = await key({ node: node({ requested: true }) })
    const withArgs = await key({ node: node({ requested: true }), forwardArgs: ['--watch'] })
    expect(withArgs).not.toBe(bare)
  })

  it('a NON-requested task ignores forwardArgs entirely', async () => {
    // The load-bearing half. A dependency pulled in by `dependsOn` derives the
    // same key whether or not the user typed trailing args for the task they
    // actually asked for.
    const bare = await key({ node: node({ requested: false }) })
    const withArgs = await key({ node: node({ requested: false }), forwardArgs: ['--watch'] })
    expect(withArgs).toBe(bare)
  })

  it('distinct forwardArgs give distinct keys on a requested task', async () => {
    const a = await key({ node: node({ requested: true }), forwardArgs: ['--watch'] })
    const b = await key({ node: node({ requested: true }), forwardArgs: ['--coverage'] })
    expect(a).not.toBe(b)
  })

  it('an EMPTY forwardArgs array matches passing none', async () => {
    // `vx run build --` (a bare separator) must not be a different cache
    // namespace from `vx run build`. The log calls this out explicitly.
    const none = await key({ node: node({ requested: true }) })
    const empty = await key({ node: node({ requested: true }), forwardArgs: [] })
    expect(empty).toBe(none)
  })
})

describe('computeTaskHash — upstream folding', () => {
  it('SENSITIVITY: an upstream key change cascades into the dependent', async () => {
    // The whole point of a task graph's cache: a dependency rebuilding must
    // invalidate everything downstream of it.
    const before = await key({ upstream: [outcome('pkg#codegen', 'u1')] })
    const after = await key({ upstream: [outcome('pkg#codegen', 'u2')] })
    expect(after).not.toBe(before)
  })

  it('STABILITY: upstream ORDER does not matter', async () => {
    // Scheduling is concurrent, so upstream outcomes arrive in whatever order
    // the workers finished. If order reached the key, the same graph would
    // derive different keys run to run — a cache that hits only by luck.
    const a = outcome('pkg#a', 'ha')
    const b = outcome('pkg#b', 'hb')
    expect(await key({ upstream: [a, b] })).toBe(await key({ upstream: [b, a] }))
  })

  it('STABILITY: renaming an upstream task does not move the key', async () => {
    // `upstreamIds` is passed to `key()` for capture-row NAMING only — so the
    // persisted `entry_inputs` diff can say "pkg#codegen changed" instead of
    // printing a bare digest. It is documented as never folded, and this pins
    // that: identical upstream hashes under different task ids agree.
    const asCodegen = await key({ upstream: [outcome('pkg#codegen', 'same')] })
    const asGenerate = await key({ upstream: [outcome('pkg#generate', 'same')] })
    expect(asGenerate).toBe(asCodegen)
  })

  it('a task with no upstream differs from one with an upstream', async () => {
    expect(await key({ upstream: [outcome('pkg#a', 'ha')] })).not.toBe(await key({ upstream: [] }))
  })

  it('cache.inputs.tasks narrows WHICH upstreams fold', async () => {
    // The documented decoupling vector: a consumer declares it only cares
    // about some upstreams, so the others' churn does not invalidate it. Here
    // the filter selects `pkg#a` only, so changing `pkg#b` must not move the
    // key while changing `pkg#a` must.
    const cfg: Partial<TaskConfig> = {
      cache: { inputs: { files: [], tasks: ['a'] }, outputs: { files: [] } },
    }
    const n = node({}, cfg)
    const base = await key({
      node: n,
      upstream: [outcome('pkg#a', 'ha'), outcome('pkg#b', 'hb')],
    })
    const bMoved = await key({
      node: n,
      upstream: [outcome('pkg#a', 'ha'), outcome('pkg#b', 'CHANGED')],
    })
    const aMoved = await key({
      node: n,
      upstream: [outcome('pkg#a', 'CHANGED'), outcome('pkg#b', 'hb')],
    })
    expect(bMoved).toBe(base)
    expect(aMoved).not.toBe(base)
  })

  it('an upstream filter selecting NOTHING makes the task blind to all of them', async () => {
    // `tasks: []` is the strongest form of the decoupling above. It is a
    // genuinely dangerous declaration — the user is asserting that no
    // upstream's output can affect this task — so it must be exact rather
    // than approximately-honoured.
    const n = node({}, { cache: { inputs: { files: [], tasks: [] }, outputs: { files: [] } } })
    const none = await key({ node: n, upstream: [] })
    const some = await key({ node: n, upstream: [outcome('pkg#a', 'ha')] })
    expect(some).toBe(none)
  })
})

describe('computeTaskHash — package.json is an implicit input', () => {
  // Turbo and Nx both fold the project manifest into every task's key. vx does
  // the same, and the reason is a real footgun: a user writing
  // `cache.inputs.files: ['src/**']` has excluded package.json without meaning
  // to, so a dependency bump or a changed script would leave every task in
  // that project warm against the old dependency tree.

  it('SENSITIVITY: changing package.json moves the key even with narrow globs', async () => {
    const pkgPath = path.join(root, 'package.json')
    const original = await Bun.file(pkgPath).text()
    try {
      // A fresh Cache per read: `hashFile` memoizes on (mtime, size, ctime,
      // inode), and this test's whole point is to observe a content change.
      const c1 = new Cache(path.join(root, '.vx-cache-pkg1'))
      const before = await key({ cache: c1 })
      c1.close()

      await writeFile(pkgPath, JSON.stringify({ name: 'pkg', dependencies: { left: '1.0.0' } }))

      const c2 = new Cache(path.join(root, '.vx-cache-pkg2'))
      const after = await key({ cache: c2 })
      c2.close()

      expect(after).not.toBe(before)
    } finally {
      await writeFile(pkgPath, original)
    }
  })

  it('a project with NO package.json hashes as empty rather than throwing', async () => {
    // Workspace discovery requires a manifest, so this is unreachable in a
    // real run — but the derivation must degrade to a defined value rather
    // than throwing, because a throw here fails the run at hash time with no
    // useful message.
    const bare = await mkdtemp(path.join(os.tmpdir(), 'vx-nopkg-'))
    try {
      const k = await key({ node: node({ projectDir: bare }) })
      expect(typeof k).toBe('string')
      expect(k.length).toBeGreaterThan(0)
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe('computeTaskHash — the per-run memo caches', () => {
  it('a hashCache produces the same key as no hashCache', async () => {
    // The memos exist purely to avoid re-reading the same package.json and
    // re-stringifying the same config object once per task. They are an
    // optimisation, so a memoised run and a cold one must agree exactly — if
    // they ever diverge, warm and cold runs address different artifacts.
    const cold = await key()
    const warm = await key({ hashCache: createHashCache() })
    expect(warm).toBe(cold)
  })

  it('the config memo is keyed by object REFERENCE, so a mutated config goes stale', async () => {
    // FINDING-adjacent, and deliberately pinned rather than "fixed": the
    // taskConfig memo is a WeakMap on the config OBJECT. Mutating a config
    // in place after its first hash returns the STALE digest.
    //
    // This is safe by construction today — `prepareRun` builds each config
    // once per run and nothing mutates it afterwards — but it is an invariant
    // the memo silently depends on, not one the type system enforces. A future
    // change that starts editing configs mid-run (a plugin hook, a per-task
    // override) would produce wrong cache keys with no error. This test is
    // here so that change fails loudly instead.
    const hc = createHashCache()
    const n = node({}, { exec: { command: 'build' } })
    const first = await key({ node: n, hashCache: hc })

    // Mutate in place — same object identity, different content.
    ;(n.config.exec as { command: string }).command = 'build --prod'
    const afterMutation = await key({ node: n, hashCache: hc })
    expect(afterMutation).toBe(first) // stale, by design of the memo

    // A FRESH memo sees the real, changed config.
    const honest = await key({ node: n, hashCache: createHashCache() })
    expect(honest).not.toBe(first)
  })

  it('two structurally identical but distinct config objects agree', async () => {
    // The flip side of reference-keying: distinct objects are separate memo
    // entries, and both must arrive at the same digest. If they did not, two
    // projects spreading the same shared preset would never share a key shape.
    const hc = createHashCache()
    const a = await key({ node: node({}, { exec: { command: 'same' } }), hashCache: hc })
    const b = await key({ node: node({}, { exec: { command: 'same' } }), hashCache: hc })
    expect(b).toBe(a)
  })

  it('the package.json memo is per-project and survives a mid-run change', async () => {
    // Also pinned as an invariant rather than a bug. The memo stores the
    // PROMISE keyed by projectDir, so the manifest is read once per run no
    // matter how many tasks a project has. A file edited while the run is in
    // flight is therefore not observed — which is correct: a run must hash a
    // single consistent snapshot of its inputs, not a moving target.
    const pkgPath = path.join(root, 'package.json')
    const original = await Bun.file(pkgPath).text()
    const hc = createHashCache()
    try {
      const before = await key({ hashCache: hc })
      await writeFile(pkgPath, JSON.stringify({ name: 'pkg', changed: true }))
      const after = await key({ hashCache: hc })
      expect(after).toBe(before)
    } finally {
      await writeFile(pkgPath, original)
    }
  })
})

describe('computeTaskHash — the trusted-OID fast path for package.json', () => {
  it('a trusted index OID short-circuits before any file read', async () => {
    // When the run's bulk `git ls-files -s` pass has already handed us the
    // manifest's index OID, hashing it must cost nothing: no exists probe, no
    // stat, no SQLite lookup, no read. This is the clean-tree path that makes
    // key derivation on a large monorepo essentially free, so a regression
    // that quietly reintroduces a per-project file read would not fail any
    // correctness test — only this one.
    // Built explicitly rather than by spreading `cache`: spreading a class
    // instance drops its prototype, so the methods would silently vanish.
    // Derivation only ever reaches for these two.
    let hashFileCalls = 0
    const counting = {
      key: cache.key.bind(cache),
      hashFile: async (p: string) => {
        hashFileCalls++
        return await cache.hashFile(p)
      },
    } as unknown as CacheLayer

    const pkgPath = path.join(root, 'package.json')
    const oids = new Map([[pkgPath, 'deadbeefdeadbeef']])
    const gitFilesCache = { oidsFor: () => oids } as never

    const k = await computeTaskHash({
      node: node(),
      upstream: [],
      workspaceRoot: root,
      workspaceFingerprint: 'ws-fp',
      cache: counting,
      nestedProjectDirs: [],
      gitFilesCache,
    })

    expect(hashFileCalls).toBe(0)
    expect(typeof k).toBe('string')
  })

  it('the trusted OID is what folds in — a different OID gives a different key', async () => {
    // Proves the short-circuit above is not just skipping work but supplying
    // the value. If the OID were ignored, these two would collide and the
    // clean-tree path would be hashing nothing at all.
    const pkgPath = path.join(root, 'package.json')
    const withOid = async (oid: string): Promise<string> =>
      await computeTaskHash({
        node: node(),
        upstream: [],
        workspaceRoot: root,
        workspaceFingerprint: 'ws-fp',
        cache,
        nestedProjectDirs: [],
        gitFilesCache: { oidsFor: () => new Map([[pkgPath, oid]]) } as never,
      })

    expect(await withOid('aaaaaaaaaaaaaaaa')).not.toBe(await withOid('bbbbbbbbbbbbbbbb'))
  })

  it('project OIDs win over workspace OIDs where the two maps overlap', async () => {
    // A task declaring `inputs.workspaceFiles` reads files anywhere under the
    // root, so its OID lookup merges the workspace-wide partition with its own
    // project's: `new Map([...wsOids, ...projectOids])`. Later entries win, so
    // on a path present in BOTH the project's value is the one that counts.
    //
    // In practice both partitions are populated from the same git index and
    // agree wherever they overlap, which is exactly why a reversal would slip
    // through unnoticed — and it would change the key of every task that reads
    // workspace files. So this makes the two maps DISAGREE and asserts which
    // one the key reflects.
    //
    // The project must be a SUBDIRECTORY of the workspace for the two lookups
    // to be distinguishable at all; with projectDir === workspaceRoot they are
    // the same partition and the precedence is unobservable.
    const projectDir = path.join(root, 'pkg')
    const pkgPath = path.join(projectDir, 'package.json')
    const cfg: Partial<TaskConfig> = {
      cache: {
        inputs: { files: [], workspaceFiles: ['nothing-matches/**'] },
        outputs: { files: [] },
      },
    }

    const merged = async (projectOid: string): Promise<string> =>
      await computeTaskHash({
        node: node({ projectDir }, cfg),
        upstream: [],
        workspaceRoot: root,
        workspaceFingerprint: 'ws-fp',
        cache,
        nestedProjectDirs: [],
        gitFilesCache: {
          oidsFor: (dir: string) =>
            dir === projectDir
              ? new Map([[pkgPath, projectOid]])
              : new Map([[pkgPath, 'wwwwwwwwwwwwwwww']]),
          // `resolveWorkspaceFiles` enumerates through the same object; an
          // empty snapshot keeps this test about OID precedence alone.
          snapshotFor: () => [],
          markOutputsChanged: () => {},
        } as never,
      })

    // The key tracks the PROJECT value: moving it moves the key, even though
    // the workspace partition's entry for that same path never changes. Under
    // reversed precedence the workspace value would win both times and these
    // two would collide.
    const a = await merged('aaaaaaaaaaaaaaaa')
    const b = await merged('bbbbbbbbbbbbbbbb')
    expect(a).not.toBe(b)
  })
})
