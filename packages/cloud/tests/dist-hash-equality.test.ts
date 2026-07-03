// The §6.3 hash-equality guard (distributed-execution-2026-07) — the
// correctness law of distribution, pinned forever:
//
//   Under the distribution contract (same commit, clean tree, same
//   configs), an agent-style SCOPED run of a task WITH its dep closure
//   derives and saves under keys byte-identical to the keys a full run
//   derives — and the submitter's `deriveStableKeys` output equals both,
//   which is what makes the serve's stat-prune sound.
//
// Plus the inverted pin: the same scoped run under
// `excludeDependencies: 'all'` derives a DIFFERENT key — dropping dep
// edges empties the `upstream` fold, so the artifact lands under a key
// no conforming run would ever derive (§6.4's counterexample in
// executable form). That is why the design rejects it.

import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deriveStableKeys, prepareRun, run, type Logger } from '@vzn/vx'

const silentLogger: Logger = {
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
}

/**
 * A cross-project dep chain with an `inputs.tasks` filter: `pkg-b#build`
 * depends on `pkg-a#build` (via `^build`) and folds every dep-project
 * upstream key (`'^*'`). Cross-project only, so pkg-b's key is STABLE
 * (project boundaries are hard — pkg-a's outputs can't land where pkg-b's
 * project-relative inputs read).
 */
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-dist-hash-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )

  const a = path.join(root, 'packages', 'pkg-a')
  await mkdir(path.join(a, 'src'), { recursive: true })
  await writeFile(path.join(a, 'package.json'), JSON.stringify({ name: 'pkg-a', version: '0.0.0' }))
  await writeFile(path.join(a, 'src', 'in.txt'), 'a-v1')
  await writeFile(
    path.join(a, 'vx.config.mjs'),
    `export default {
       tasks: {
         build: {
           exec: { command: 'mkdir -p dist && echo built-a > dist/out.txt' },
           cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
         },
       },
     }`,
  )

  const b = path.join(root, 'packages', 'pkg-b')
  await mkdir(path.join(b, 'src'), { recursive: true })
  await writeFile(
    path.join(b, 'package.json'),
    JSON.stringify({ name: 'pkg-b', version: '0.0.0', dependencies: { 'pkg-a': 'workspace:*' } }),
  )
  await writeFile(path.join(b, 'src', 'in.txt'), 'b-v1')
  await writeFile(
    path.join(b, 'vx.config.mjs'),
    `export default {
       tasks: {
         build: {
           exec: { command: 'mkdir -p dist && echo built-b > dist/out.txt' },
           dependsOn: ['^build'],
           cache: { inputs: { files: ['src/**'], tasks: ['^*'] }, outputs: { files: ['dist/**'] } },
         },
       },
     }`,
  )

  const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
  git('init', '-q')
  git('config', 'user.email', 't@vx.local')
  git('config', 'user.name', 'vx test')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return root
}

describe('§6.3 hash equality — agent scoped-run keys ARE full-run keys', () => {
  it('submitted stable key == agent-style scoped-run saved key == full-run key; excludeDependencies diverges', async () => {
    const root = await makeWorkspace()
    try {
      // 1. The submitter's derivation: full prepare + deriveStableKeys.
      const prepared = await prepareRun({ cwd: root, tasks: ['build'] }, silentLogger)
      expect(prepared.empty).toBeNull()
      const stable = await deriveStableKeys({
        nodes: prepared.nodes,
        cache: prepared.cache,
        workspaceRoot: prepared.workspaceRoot,
        workspaceFingerprint: prepared.workspaceFingerprint,
        nestedDirsByProject: prepared.nestedDirsByProject,
        gitFilesCache: prepared.gitFilesCache,
        hashCache: prepared.hashCache,
      })
      prepared.cache.close()
      const submittedKey = stable.find((s) => s.node.id === 'pkg-b#build')?.hash
      // Cross-project deps only → pkg-b#build is stable and carries a key.
      expect(submittedKey).toBeDefined()

      // 2. Agent-style execution: a scoped run of the exact task id WITH
      //    its dep closure (what every assignment runs).
      const scoped = await run({
        cwd: root,
        tasks: ['pkg-b#build'],
        log: silentLogger,
        handleSignals: false,
      })
      expect(scoped.ok).toBe(true)
      const scopedB = scoped.outcomes.find((o) => o.node.id === 'pkg-b#build')
      expect(scopedB?.status).toBe('success')
      // The saved entry hash equals the submitter's derivation — the
      // serve-side stat prune and warm-rerun-assigns-nothing are sound.
      expect(scopedB?.hash).toBe(submittedKey!)

      // 3. A FULL run derives the same key (it cache-hits the scoped
      //    run's artifact rather than re-executing).
      const full = await run({
        cwd: root,
        tasks: ['build'],
        log: silentLogger,
        handleSignals: false,
      })
      expect(full.ok).toBe(true)
      const fullB = full.outcomes.find((o) => o.node.id === 'pkg-b#build')
      expect(fullB?.hash).toBe(submittedKey!)
      expect(fullB?.status).toBe('cache-hit')

      // 4. The inverted pin (§6.4): dropping the dep edges empties the
      //    upstream fold → a DIFFERENT key. Fresh cache so the run
      //    actually derives + saves.
      await rm(path.join(root, '.vx'), { recursive: true, force: true })
      const excluded = await run({
        cwd: root,
        tasks: ['pkg-b#build'],
        excludeDependencies: 'all',
        log: silentLogger,
        handleSignals: false,
      })
      expect(excluded.ok).toBe(true)
      const excludedB = excluded.outcomes.find((o) => o.node.id === 'pkg-b#build')
      expect(excludedB?.hash).toBeDefined()
      expect(excludedB?.hash).not.toBe(submittedKey!)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
