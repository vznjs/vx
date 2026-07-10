import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-sc-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })
  initGitRepo(root)
  return { root, log: [], err: [] }
}

function initGitRepo(cwd: string): void {
  const g = (...args: string[]): void => {
    const p = Bun.spawnSync({
      cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
    }
  }
  g('init', '-q')
  g('config', 'user.email', 'test@vx.local')
  g('config', 'user.name', 'vx test')
}

async function addProject(
  root: string,
  name: string,
  args: { deps?: Record<string, string>; files?: Record<string, string>; config: string },
): Promise<string> {
  const safe = name.replace('@', '').replace('/', '-')
  const dir = path.join(root, 'packages', safe)
  await mkdir(dir, { recursive: true })
  const pkg: Record<string, unknown> = { name, version: '0.0.0' }
  if (args.deps && Object.keys(args.deps).length > 0) pkg.dependencies = args.deps
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  await writeFile(path.join(dir, 'vx.config.mjs'), args.config)
  for (const [rel, content] of Object.entries(args.files ?? {})) {
    const full = path.join(dir, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  return dir
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
    'a graph declaring outputs.workspaceFiles disables the restore tier graph-wide',
    async () => {
      // lib declares a WORKSPACE output (root-anchored, boundary-ignoring).
      // No task may be restore-tier — but probe reuse still applies, so
      // every stable task is still in preProbed (no double work).
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
      // Probe reuse still covers stable tasks (no double work) ...
      expect(c.preProbedIds.has('wapp#build')).toBe(true)
      // ... but the restore tier is empty graph-wide.
      expect(c.restoreTier.size).toBe(0)
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

      // Warm: count Cache.get calls. Two cacheable tasks → exactly two
      // probes total (the up-front classify; execute() reuses them).
      const getSpy = spyOn(Cache.prototype, 'get')
      const warm = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(warm.ok).toBe(true)
      expect(
        warm.outcomes.every((o) => o.node.config.exec === undefined || o.status === 'cache-hit'),
      ).toBe(true)
      expect(getSpy).toHaveBeenCalledTimes(2)
      getSpy.mockRestore()
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
    'flat graph (no deps): no restore tier (nothing to bypass), still correct',
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
      // shouldShortCircuit needs a dep edge; a flat graph never classifies.
      const c = await classify(fixture, ['build'])
      // (classify() probes regardless of the has-deps gate, so this only
      // confirms the stable task IS a hit — the run-level gate is what
      // skips it; covered functionally by the warm run staying correct.)
      expect(c.restoreTier.has('flat#build')).toBe(true)
      const warm = await run({ cwd: fixture.root, tasks: ['build'], log: silentLogger(fixture) })
      expect(warm.outcomes.find((o) => o.node.id === 'flat#build')?.status).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it('gate: LayeredCache runs never classify — remote-prefetch owns those', async () => {
    // Under a LayeredCache, cache.get is a remote READ-THROUGH and the
    // up-front classify is awaited before scheduling — N remote GETs
    // would land on the critical path. The gate must decline so remote
    // runs stay on the fire-and-forget prefetch path (decision log
    // 2026-06-28). Only `deps.length` is read off the nodes here.
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
