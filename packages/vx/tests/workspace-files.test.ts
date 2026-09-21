// workspaceFiles — workspace-root-anchored inputs + outputs (the
// Turbo $TURBO_ROOT$ / Nx {workspaceRoot} equivalent). Pins the
// owner-decided semantics:
//   - NO project-boundary rule for these globs: they may match files
//     inside other projects' dirs (deliberate escape hatch).
//   - Input resolution is git-aware (gitignored files invisible).
//   - Key derivation is unchanged: resolved workspaceFiles join the
//     same inputFiles list; an absent field and `workspaceFiles: []`
//     resolve to identical inputs and derive identical keys.
//   - Outputs pack into an additive `workspace-outputs/<rel-to-root>`
//     artifact namespace; tasks not using the field produce
//     byte-identical artifacts (no CACHE_VERSION bump).

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitInit, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { Cache } from '../src/cache/cache.js'
import { GitFilesCache, populateGitFilesCache, resolveInputs } from '../src/cache/inputs.js'
import { scanArtifact } from '../src/cache/archive.js'
import { streamOf } from './helpers/stream.js'
import { validateProjectConfig } from '../src/workspace/project-loader.js'
import { computeTaskHash } from '../src/orchestrator/task-hash.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

const TIMEOUT = 30_000

async function write(p: string, content = 'x'): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

function git(cwd: string, ...args: string[]): void {
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

// ─── Loader validation ───────────────────────────────────────────────

describe('workspaceFiles loader validation', () => {
  const cfgWith = (cache: Record<string, unknown>): Record<string, unknown> => ({
    tasks: { build: { exec: { command: 'true' }, cache } },
  })
  const validate = (cache: Record<string, unknown>): void => {
    validateProjectConfig(cfgWith(cache), '/ws/pkg/vx.config.ts')
  }
  const base = { inputs: { files: ['src/**'] }, outputs: { files: [] } }

  it('accepts string arrays with negation in inputs.workspaceFiles', () => {
    validate({ ...base, inputs: { files: [], workspaceFiles: ['shared/**', '!shared/skip.ts'] } })
  })

  it('accepts outputs.workspaceFiles', () => {
    validate({ ...base, outputs: { files: [], workspaceFiles: ['generated/**'] } })
  })

  it('rejects non-array inputs.workspaceFiles', () => {
    expect(() => validate({ ...base, inputs: { files: [], workspaceFiles: 'shared/**' } })).toThrow(
      /inputs\.workspaceFiles/,
    )
  })

  it('rejects empty strings', () => {
    expect(() => validate({ ...base, inputs: { files: [], workspaceFiles: [''] } })).toThrow(
      /non-empty/,
    )
  })

  it('rejects absolute paths in both fields', () => {
    expect(() => validate({ ...base, inputs: { files: [], workspaceFiles: ['/etc/x'] } })).toThrow(
      /absolute/,
    )
    expect(() => {
      validate({ ...base, outputs: { files: [], workspaceFiles: ['/var/y'] } })
    }).toThrow(/absolute/)
    expect(() => validate({ ...base, inputs: { files: [], workspaceFiles: ['!/etc/x'] } })).toThrow(
      /absolute/,
    )
  })

  it('rejects non-array outputs.workspaceFiles', () => {
    expect(() => validate({ ...base, outputs: { files: [], workspaceFiles: {} } })).toThrow(
      /outputs\.workspaceFiles/,
    )
  })
})

// ─── Input resolution ────────────────────────────────────────────────

describe('inputs.workspaceFiles resolution', () => {
  let root: string
  let aDir: string
  let bDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-wsf-'))
    aDir = path.join(root, 'packages', 'a')
    bDir = path.join(root, 'packages', 'b')
    await write(path.join(root, 'shared', 'config.json'), '{}')
    await write(path.join(root, 'shared', 'ignored.txt'), 'invisible')
    await write(path.join(root, '.gitignore'), 'shared/ignored.txt\n')
    await write(path.join(aDir, 'src', 'main.ts'), 'a')
    await write(path.join(aDir, 'package.json'), '{"name":"a"}')
    await write(path.join(bDir, 'src', 'lib.ts'), 'b')
    await write(path.join(bDir, 'package.json'), '{"name":"b"}')
    gitInit(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const resolveA = async (inputs: {
    files: string[]
    workspaceFiles?: string[]
  }): Promise<string[]> => {
    const r = await resolveInputs({
      projectDir: aDir,
      workspaceRoot: root,
      envSource: {},
      inputs,
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    return r.files
  }

  it('matches root files; gitignored root files stay invisible', async () => {
    const files = await resolveA({ files: ['src/**'], workspaceFiles: ['shared/**'] })
    expect(files).toContain(path.join(root, 'shared', 'config.json'))
    expect(files).toContain(path.join(aDir, 'src', 'main.ts'))
    expect(files).not.toContain(path.join(root, 'shared', 'ignored.txt'))
  })

  it('matches files INSIDE a sibling project dir (no-boundary escape hatch)', async () => {
    const files = await resolveA({ files: ['src/**'], workspaceFiles: ['packages/b/src/**'] })
    expect(files).toContain(path.join(bDir, 'src', 'lib.ts'))
  })

  it('supports ! negation', async () => {
    await write(path.join(root, 'shared', 'extra.json'), '{}')
    const files = await resolveA({
      files: [],
      workspaceFiles: ['shared/**', '!shared/config.json'],
    })
    expect(files).toEqual([path.join(root, 'shared', 'extra.json')])
  })

  it('a mid-run workspace-output change re-enumerates for the RESOLVER too', async () => {
    // `snapshotFor` takes the caller's input globs and drops the snapshot
    // only when a pending changed path matches one of them. That
    // behaviour is well pinned — by rows that call `snapshotFor`
    // DIRECTLY. Which is the one door `resolveWorkspaceFiles` does not
    // use: pass it an empty glob list and nothing ever matches, so a
    // partition invalidated mid-run is handed back anyway and a task's
    // workspace inputs are the file set from BEFORE its upstream wrote
    // them. A stale hit, and the whole invalidation path had no witness
    // from the caller's side (the 544 shape).
    const cache = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], cache, true)
    // An upstream task rewrote a workspace output this task reads.
    await write(path.join(root, 'shared', 'late.json'), '{"late":true}')
    cache.markWorkspaceOutputsChanged(root, ['shared/late.json'])

    const r = await resolveInputs({
      projectDir: aDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['shared/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: cache,
    })
    expect(r.files).toContain(path.join(root, 'shared', 'late.json'))
  })

  it('the re-enumeration is STORED, so the partition is usable again', async () => {
    // The twin of the project half's `set()`, which that half's own sweep
    // catches. `set()` caches the fresh list AND clears the partition's
    // pending-changed bookkeeping; without it every later task in the run
    // re-spawns `git ls-files` at the workspace root, forever, because
    // the invalidation is never retired.
    //
    // NOT asserted through the OIDs: `markWorkspaceOutputsChanged` drops
    // the changed path's OID by itself, so a row watching that would pass
    // either way (rule 15). What only `set()` decides is whether the
    // partition answers at all afterwards.
    const g = (): Bun.Glob => new Bun.Glob('shared/**')
    const cache = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], cache, true)
    cache.markWorkspaceOutputsChanged(root, ['shared/config.json'])
    expect(cache.snapshotFor(root, [g()])).toBeUndefined()

    await resolveInputs({
      projectDir: aDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['shared/**'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: cache,
    })
    expect(cache.snapshotFor(root, [g()])).toBeDefined()
  })

  it('two tasks with different workspaceFiles do not share a memo answer', async () => {
    // The memo key is `[positive, negative, ownWorkspaceOutputs]`, and
    // only the negation arm had a witness. Both siblings are reachable
    // the same everyday way — two tasks of one project declaring
    // different root-level inputs — and the memo answers from cache only
    // when the snapshot ARRAY is identical, which is exactly what one
    // shared `GitFilesCache` gives the second call.
    await write(path.join(root, 'other', 'thing.json'), '{}')
    const cache = new GitFilesCache()
    const memo = new Map()
    const resolve = async (
      workspaceFiles: string[],
      ownWorkspaceOutputs: string[] = [],
    ): Promise<string[]> =>
      (
        await resolveInputs({
          projectDir: aDir,
          workspaceRoot: root,
          envSource: {},
          inputs: { files: [], workspaceFiles },
          ownOutputs: [],
          ownWorkspaceOutputs,
          nestedProjectDirs: [],
          gitFilesCache: cache,
          workspaceFilesCache: memo,
        })
      ).files

    expect(await resolve(['shared/**'])).toEqual([path.join(root, 'shared', 'config.json')])
    expect(await resolve(['other/**'])).toEqual([path.join(root, 'other', 'thing.json')])
    // Same globs, different declared outputs: the exclusion must still apply.
    expect(await resolve(['shared/**'], ['shared/config.json'])).toEqual([])
  })

  it('a bare directory means its whole tree, on every one of the three lists', async () => {
    // `asTrees` is applied to the positives, the negations and the task's
    // own workspace outputs, and none of the three had a witness in this
    // twin — every fixture here spells `shared/**`. A user writing
    // `workspaceFiles: ['shared']` is writing the documented form.
    await write(path.join(root, 'shared', 'extra.json'), '{}')
    const resolve = async (
      workspaceFiles: string[],
      ownWorkspaceOutputs: string[] = [],
    ): Promise<string[]> =>
      (
        await resolveInputs({
          projectDir: aDir,
          workspaceRoot: root,
          envSource: {},
          inputs: { files: [], workspaceFiles },
          ownOutputs: [],
          ownWorkspaceOutputs,
          nestedProjectDirs: [],
        })
      ).files.sort()

    const both = [path.join(root, 'shared', 'config.json'), path.join(root, 'shared', 'extra.json')]
    expect(await resolve(['shared'])).toEqual(both)
    expect(await resolve(['shared/**', '!shared'])).toEqual([])
    expect(await resolve(['shared'], ['shared'])).toEqual([])
  })

  it('excludes the task own outputs.workspaceFiles globs', async () => {
    const r = await resolveInputs({
      projectDir: aDir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: [], workspaceFiles: ['shared/**'] },
      ownOutputs: [],
      ownWorkspaceOutputs: ['shared/config.json'],
      nestedProjectDirs: [],
    })
    expect(r.files).toEqual([])
  })

  it('a task own outputs.workspaceFiles leave its KEY alone — the wire, not just resolveInputs', async () => {
    // The row above pins the EXCLUSION, by calling `resolveInputs` with
    // `ownWorkspaceOutputs` itself. What nothing held is the WIRE:
    // `task-hash.ts` passing `cache.outputs.workspaceFiles` down to it.
    // Hand it `[]` there and the exclusion is perfect and never reached —
    // the task folds its own generated file, so its key moves after every
    // run and it never hits again.
    //
    // The project-level twin of this law ("does not self-invalidate when
    // only its declared outputs change") is held end-to-end by 22 rows.
    // The workspace-level array arrived later and inherited none of them,
    // which is this repo's standing finding about a rule with two copies.
    const generated = path.join(root, 'shared', 'generated.json')
    await write(generated, '{"v":1}')
    const cache = new Cache(path.join(root, '.vx', 'cache'))
    try {
      const key = (): Promise<string> =>
        computeTaskHash({
          node: {
            id: 'a#build',
            projectName: 'a',
            projectDir: aDir,
            taskName: 'build',
            config: {
              exec: { command: 'gen' },
              cache: {
                inputs: { files: [], workspaceFiles: ['shared/**'] },
                outputs: { files: [], workspaceFiles: ['shared/generated.json'] },
              },
            },
            deps: [],
            requested: false,
          },
          upstream: [],
          workspaceRoot: root,
          workspaceFingerprint: 'fp',
          cache,
          nestedProjectDirs: [],
        })

      const before = await key()
      await write(generated, '{"v":2}')
      expect(await key()).toBe(before)

      // CONTROL, on a DIFFERENT file: a workspace input that is not a
      // declared output still moves the key. Without it the assertion
      // above would pass just as well on a task that reads no workspace
      // files at all.
      await write(path.join(root, 'shared', 'config.json'), '{"changed":true}')
      expect(await key()).not.toBe(before)
    } finally {
      cache.close()
    }
  })

  it('absent field and workspaceFiles: [] resolve identically and derive the same key', async () => {
    const absent = await resolveA({ files: ['src/**'] })
    const empty = await resolveA({ files: ['src/**'], workspaceFiles: [] })
    expect(empty).toEqual(absent)

    const cacheDir = path.join(root, '.vx', 'cache')
    const cache = new Cache(cacheDir)
    try {
      const keyFor = (inputFiles: string[]): Promise<string> =>
        cache.key({
          taskId: 'a#build',
          taskConfigHash: 'cfg',
          envValues: [],
          inputFiles,
          workspaceRoot: root,
          upstreamHashes: [],
          workspaceFingerprint: 'fp',
          projectPackageJsonHash: 'pkg',
        })
      expect(await keyFor(empty)).toBe(await keyFor(absent))
    } finally {
      cache.close()
    }
  })
})

// ─── GitFilesCache workspace partition ───────────────────────────────

describe('GitFilesCache workspace-wide partition', () => {
  let root: string
  let aDir: string
  let bDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-wsg-'))
    aDir = path.join(root, 'packages', 'a')
    bDir = path.join(root, 'packages', 'b')
    await write(path.join(root, 'shared', 'config.json'), '{}')
    await write(path.join(aDir, 'src', 'main.ts'), 'a')
    await write(path.join(bDir, 'src', 'lib.ts'), 'b')
    gitInit(root)
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'init')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('workspaceWide stores a root partition with trusted OIDs', async () => {
    const cache = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], cache, true)
    expect(cache.has(root)).toBe(true)
    const snap = cache.snapshotFor(root, [new Bun.Glob('shared/**')])
    expect(snap).toContain('shared/config.json')
    expect(cache.oidsFor(root)?.has(path.join(root, 'shared', 'config.json'))).toBe(true)
    // Per-project partitions still present alongside.
    expect(cache.snapshotFor(aDir, [new Bun.Glob('src/**')])).toContain('src/main.ts')
  })

  it('without the flag no workspace partition exists (unused-feature pin)', async () => {
    const cache = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], cache)
    expect(cache.has(root)).toBe(false)
    // And the workspace-partition hooks are no-ops.
    cache.markOutputsChanged(aDir, ['src/main.ts'])
    cache.invalidateWorkspacePartition()
    expect(cache.has(aDir)).toBe(true)
  })

  it('markWorkspaceOutputsChanged invalidates overlapping snapshots in every partition', async () => {
    const cache = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], cache, true)
    cache.markWorkspaceOutputsChanged(root, ['packages/a/src/main.ts'])
    // Root partition: overlapping glob re-spawns, disjoint glob reuses.
    expect(cache.snapshotFor(root, [new Bun.Glob('packages/a/**')])).toBeUndefined()
    expect(cache.snapshotFor(root, [new Bun.Glob('shared/**')])).toBeDefined()
    // The project partition containing the path sees it project-relative.
    expect(cache.snapshotFor(aDir, [new Bun.Glob('src/**')])).toBeUndefined()
    // Unrelated project untouched.
    expect(cache.snapshotFor(bDir, [new Bun.Glob('src/**')])).toBeDefined()
    // OID dropped for the changed path only.
    expect(cache.oidsFor(root)?.has(path.join(aDir, 'src', 'main.ts'))).toBe(false)
    expect(cache.oidsFor(root)?.has(path.join(root, 'shared', 'config.json'))).toBe(true)
  })

  it('markOutputsChanged forwards project-relative paths to the workspace partition', async () => {
    const cache = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], cache, true)
    cache.markOutputsChanged(aDir, ['src/main.ts'])
    expect(cache.snapshotFor(root, [new Bun.Glob('packages/a/src/**')])).toBeUndefined()
    expect(cache.snapshotFor(root, [new Bun.Glob('shared/**')])).toBeDefined()
  })

  it('the workspace partition OIDs reach the key — the merge itself, not its precedence', async () => {
    // `task-hash` merges the workspace-wide OID partition into the
    // project's for a task declaring `inputs.workspaceFiles`, because a
    // workspace glob reaches files the project's own partition never
    // enumerated. `task-hash-derive.test.ts` pins which map WINS on a path
    // present in both — and that row, by construction, still passes when
    // the merge is deleted outright: its path is in the project map too.
    // What the merge exists for is a path only the workspace map has.
    //
    // Deleting it costs no correctness (the fallback recomputes the same
    // blob OID from the worktree, measured: identical key) but every
    // shared file then pays a stat + SQLite lookup, or a full read on a
    // cold memo, on the warm path this partition was added to make free.
    // So the pin is that the supplied OID is the value that FOLDS.
    const shared = path.join(root, 'shared', 'config.json')
    const gfc = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], gfc, true)
    expect(gfc.oidsFor(root)?.has(shared)).toBe(true)
    expect(gfc.oidsFor(aDir)?.has(shared)).toBe(false)

    const cache = new Cache(path.join(root, '.vx', 'cache'))
    try {
      const keyWithWorkspaceOid = (oid: string): Promise<string> =>
        computeTaskHash({
          node: {
            id: 'a#build',
            projectName: 'a',
            projectDir: aDir,
            taskName: 'build',
            config: {
              exec: { command: 'build' },
              cache: {
                inputs: { files: [], workspaceFiles: ['shared/**'] },
                outputs: { files: [] },
              },
            },
            deps: [],
            requested: false,
          },
          upstream: [],
          workspaceRoot: root,
          workspaceFingerprint: 'fp',
          cache,
          nestedProjectDirs: [],
          gitFilesCache: {
            oidsFor: (dir: string) => (dir === root ? new Map([[shared, oid]]) : gfc.oidsFor(dir)),
            snapshotFor: (dir: string, globs: readonly Bun.Glob[]) => gfc.snapshotFor(dir, globs),
            set: (dir: string, files: readonly string[]) => gfc.set(dir, files),
            markOutputsChanged: () => {},
          } as never,
        })

      // Unmerged, the workspace map is never consulted and both calls fall
      // back to hashing the same unchanged bytes — one key, not two.
      expect(await keyWithWorkspaceOid('aaaaaaaaaaaaaaaa')).not.toBe(
        await keyWithWorkspaceOid('bbbbbbbbbbbbbbbb'),
      )
    } finally {
      cache.close()
    }
  })

  it('invalidateWorkspacePartition drops the root partition only when workspace-wide', async () => {
    const cache = new GitFilesCache()
    await populateGitFilesCache(root, [aDir, bDir], cache, true)
    cache.invalidateWorkspacePartition()
    expect(cache.has(root)).toBe(false)
    expect(cache.has(aDir)).toBe(true)
  })
})

// ─── Artifact namespace (Cache unit) ─────────────────────────────────

describe('workspace-outputs artifact namespace', () => {
  let dir: string
  let cacheDir: string
  let projectDir: string
  let wsRoot: string
  let cache: Cache

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-wsart-'))
    cacheDir = path.join(dir, 'cache')
    wsRoot = path.join(dir, 'ws')
    projectDir = path.join(wsRoot, 'pkg')
    await mkdir(projectDir, { recursive: true })
    cache = new Cache(cacheDir)
  })

  afterEach(async () => {
    cache.close()
    await rm(dir, { recursive: true, force: true })
  })

  const entry = { taskId: 'pkg#gen', command: 'gen', exitCode: 0, durationMs: 5, stdout: '' }

  async function tarNames(hash: string): Promise<string[]> {
    const compressed = await Bun.file(cache.outputsPath(hash)).bytes()
    const { entries } = await scanArtifact(streamOf(await Bun.zstdDecompress(compressed)))
    return entries.map((e) => e.name)
  }

  it('packs both namespaces, indexes rows with the prefix discriminator, restores each anchor', async () => {
    await write(path.join(projectDir, 'out', 'p.txt'), 'project-out')
    await write(path.join(wsRoot, 'gen', 'root.txt'), 'root-out')
    await cache.save({
      hash: 'ws1',
      entry,
      projectDir,
      outputFiles: [path.join(projectDir, 'out', 'p.txt')],
      workspaceOutputFiles: [path.join(wsRoot, 'gen', 'root.txt')],
      workspaceRoot: wsRoot,
    })

    expect((await tarNames('ws1')).sort()).toEqual([
      'outputs/out/p.txt',
      'stdout',
      'workspace-outputs/gen/root.txt',
    ])
    const hit = await cache.get('ws1')
    expect(hit?.outputFiles.sort()).toEqual(['out/p.txt', 'workspace-outputs/gen/root.txt'])

    const p2 = path.join(dir, 'restore-pkg')
    const r2 = path.join(dir, 'restore-root')
    await cache.restoreOutputs('ws1', p2, r2)
    expect(await readFile(path.join(p2, 'out', 'p.txt'), 'utf8')).toBe('project-out')
    expect(await readFile(path.join(r2, 'gen', 'root.txt'), 'utf8')).toBe('root-out')
  })

  it('without workspaceRoot, restore materializes only the project namespace', async () => {
    await write(path.join(wsRoot, 'gen', 'root.txt'), 'root-out')
    await cache.save({
      hash: 'ws2',
      entry,
      projectDir,
      outputFiles: [],
      workspaceOutputFiles: [path.join(wsRoot, 'gen', 'root.txt')],
      workspaceRoot: wsRoot,
    })
    const p2 = path.join(dir, 'restore-only-proj')
    await cache.restoreOutputs('ws2', p2)
    expect(existsSync(path.join(p2, 'gen', 'root.txt'))).toBe(false)
    expect(existsSync(path.join(p2, 'workspace-outputs'))).toBe(false)
  })

  it('tasks without the field produce the pre-workspaceFiles artifact layout', async () => {
    await write(path.join(projectDir, 'out.txt'), 'v')
    await cache.save({
      hash: 'plain',
      entry,
      projectDir,
      outputFiles: [path.join(projectDir, 'out.txt')],
    })
    expect((await tarNames('plain')).sort()).toEqual(['outputs/out.txt', 'stdout'])
  })
})

// ─── e2e through run() ───────────────────────────────────────────────

interface Fixture {
  root: string
  log: string[]
}

const silentLogger = (fixture: Fixture): Logger => ({
  status(line) {
    fixture.log.push(line)
  },
  taskStdout() {},
  taskStderr() {},
  taskComplete(node, outcome) {
    fixture.log.push(`task ${node.id} ${outcome.status}`)
  },
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-wse2e-' })
  return { root, log: [] }
}

describe('workspaceFiles e2e', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const doRun = async (): Promise<string | undefined> => {
    const summary = await run({
      cwd: fixture.root,
      tasks: ['gen'],
      log: silentLogger(fixture),
    })
    expect(summary.ok).toBe(true)
    return summary.outcomes.find((o) => o.node.id === 'pkg-a#gen')?.status
  }

  it(
    'declared root file busts the key; undeclared sibling file does not',
    async () => {
      await write(path.join(fixture.root, 'shared', 'cfg.txt'), 'v1')
      await addProject(fixture.root, 'pkg-a', {
        files: { 'src/in.txt': 'in' },
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: 'echo done > out.txt' },
                cache: {
                  inputs: { files: ['src/**'], workspaceFiles: ['shared/**'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'pkg-b', { files: { 'data/d.txt': 'v1' } })

      expect(await doRun()).toBe('success')
      expect(await doRun()).toBe('cache-hit')

      await write(path.join(fixture.root, 'shared', 'cfg.txt'), 'v2')
      expect(await doRun()).toBe('success')

      await write(path.join(fixture.root, 'packages', 'pkg-b', 'data', 'd.txt'), 'v2')
      expect(await doRun()).toBe('cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a workspaceFiles glob reaching into a sibling project participates in the key',
    async () => {
      await addProject(fixture.root, 'pkg-a', {
        files: { 'src/in.txt': 'in' },
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: 'echo done > out.txt' },
                cache: {
                  inputs: { files: ['src/**'], workspaceFiles: ['packages/pkg-b/data/**'] },
                  outputs: { files: ['out.txt'] },
                },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'pkg-b', { files: { 'data/d.txt': 'v1' } })

      expect(await doRun()).toBe('success')
      expect(await doRun()).toBe('cache-hit')
      await write(path.join(fixture.root, 'packages', 'pkg-b', 'data', 'd.txt'), 'v2')
      expect(await doRun()).toBe('success')
    },
    TIMEOUT,
  )

  it(
    'outputs.workspaceFiles: cached, wiped, restored at the workspace root',
    async () => {
      const genCmd =
        'mkdir -p ../../generated && echo root-v1 > ../../generated/api.txt && echo done > out.txt'
      await addProject(fixture.root, 'pkg-a', {
        files: { 'src/in.txt': 'in' },
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: ${JSON.stringify(genCmd)} },
                cache: {
                  inputs: { files: ['src/**'] },
                  outputs: { files: ['out.txt'], workspaceFiles: ['generated/**'] },
                },
              },
            },
          }
        `,
      })

      expect(await doRun()).toBe('success')
      const apiPath = path.join(fixture.root, 'generated', 'api.txt')
      expect(await readFile(apiPath, 'utf8')).toBe('root-v1\n')

      // Delete the root output + plant a stale straggler: the hit must
      // restore the snapshot bit-for-bit (stale file wiped).
      await rm(path.join(fixture.root, 'generated'), { recursive: true, force: true })
      await write(path.join(fixture.root, 'generated', 'stale.txt'), 'stale')
      expect(await doRun()).toBe('cache-hit')
      expect(await readFile(apiPath, 'utf8')).toBe('root-v1\n')
      expect(existsSync(path.join(fixture.root, 'generated', 'stale.txt'))).toBe(false)

      // Tree already current → still a hit, file untouched.
      expect(await doRun()).toBe('cache-hit')
      expect(await readFile(apiPath, 'utf8')).toBe('root-v1\n')
    },
    TIMEOUT,
  )
})
