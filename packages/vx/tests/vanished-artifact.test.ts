// A cache entry whose artifact is removed between the probe and the restore
// — a `vx cache prune` in another shell, or the `cacheRetention` of another
// workspace sharing `--cache-dir` — is a MISS: the task runs and the run
// stays green. It failed every such task with "internal error …
// CorruptArtifactError: artifact file vanished before restore" (upstream
// survey: nx#36688, 236 of 400 hits failed under a concurrent prune;
// nx#34032, the shared-directory eviction). A task the local short-circuit
// restores AHEAD of its dependencies cannot run in that slot: it goes back
// to the schedule and runs once they are done, or it would build from
// outputs they have not written yet and save that under a good key.

import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000

interface Seen {
  status: string[]
  complete: string[]
  started: string[]
}

function logger(seen: Seen): Logger {
  return {
    status(line) {
      seen.status.push(line)
    },
    taskStdout() {},
    taskStderr() {},
    taskStart(node) {
      seen.started.push(node.id)
    },
    taskComplete(node, outcome) {
      seen.complete.push(`${node.id} ${outcome.status}`)
    },
  }
}

/** Every restore finds its artifact gone: removed after the probe, before the read. */
function vanishOnRestore(): { restored: string[]; restore: () => void } {
  const original = Cache.prototype.restoreOutputs
  const restored: string[] = []
  const spy = spyOn(Cache.prototype, 'restoreOutputs').mockImplementation(async function (
    this: Cache,
    hash: string,
    projectDir: string,
    workspaceRoot?: string,
  ) {
    restored.push(hash)
    await rm(this.outputsPath(hash))
    return original.call(this, hash, projectDir, workspaceRoot)
  })
  return { restored, restore: () => spy.mockRestore() }
}

describe('a cache artifact that vanishes before its restore', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-vanished-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // One worker: the restore lane has one slot, so a demoted restore must
  // not hold it waiting. Four: both restores run at once, and app is
  // demoted while lib is still running — it waits for lib's outcome.
  for (const concurrency of [1, 4]) {
    it(
      `restored ahead of its dependency (concurrency ${concurrency}): runs after it, never in its place`,
      async () => {
        const libDir = await addProject(root, 'lib', {
          files: { 'src/a.txt': 'a', '.gitignore': 'dist/\n' },
          config: `
          export default {
            tasks: {
              build: {
                exec: { command: "mkdir -p dist && node -e 'process.stdout.write(String(process.hrtime.bigint()))' > dist/out.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        })
        // app reads lib's output: run before lib, the `cat` fails.
        const appDir = await addProject(root, 'app', {
          deps: { lib: 'workspace:*' },
          files: { 'src/b.txt': 'b', '.gitignore': 'dist/\n' },
          config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^build'],
                exec: { command: 'mkdir -p dist && cat ../lib/dist/out.txt > dist/built.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        })
        const cold = await run({
          cwd: root,
          tasks: ['build'],
          log: logger({ status: [], complete: [], started: [] }),
        })
        expect(cold.ok).toBe(true)
        await rm(path.join(libDir, 'dist'), { recursive: true, force: true })
        await rm(path.join(appDir, 'dist'), { recursive: true, force: true })

        const seen: Seen = { status: [], complete: [], started: [] }
        const vanish = vanishOnRestore()
        let warm
        try {
          warm = await run({ cwd: root, tasks: ['build'], concurrency, log: logger(seen) })
        } finally {
          vanish.restore()
        }
        // Both were restore-tier hits whose restore found nothing.
        expect(vanish.restored).toHaveLength(2)
        expect(warm.ok).toBe(true)
        expect(seen.complete).toEqual(['lib#build success', 'app#build success'])
        // Started once each: the second dispatch is the same task, not a new one.
        expect([...seen.started].sort()).toEqual(['app#build', 'lib#build'])
        const libOut = await readFile(path.join(libDir, 'dist/out.txt'), 'utf8')
        expect(await readFile(path.join(appDir, 'dist/built.txt'), 'utf8')).toBe(libOut)
        expect(
          seen.status.filter((l) => l.includes('vanished')).map((l) => l.split(':')[0]),
        ).toEqual(expect.arrayContaining(['[vx] lib#build', '[vx] app#build']))
        expect(seen.status.filter((l) => l.includes('vanished'))).toHaveLength(2)

        // The re-run saved: the next run hits and restores.
        await rm(path.join(appDir, 'dist'), { recursive: true, force: true })
        const next: Seen = { status: [], complete: [], started: [] }
        const again = await run({ cwd: root, tasks: ['build'], log: logger(next) })
        expect(again.ok).toBe(true)
        expect([...next.complete].sort()).toEqual(['app#build cache-hit', 'lib#build cache-hit'])
        expect(await readFile(path.join(appDir, 'dist/built.txt'), 'utf8')).toBe(libOut)
      },
      TIMEOUT,
    )
  }

  it(
    'probed in its own slot: runs there',
    async () => {
      // `consume` reads `**/*`, which `codegen`'s output can match, so its key
      // is not known up front: it is probed when it runs, after `codegen`.
      const genDir = await addProject(root, 'gen', {
        files: { 'src/seed.txt': 'seed' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: "cp src/seed.txt generated.txt" },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
              },
              consume: {
                dependsOn: ['codegen'],
                exec: { command: "cat generated.txt > out.txt" },
                cache: { inputs: { files: ['**/*'] }, outputs: { files: ['out.txt'] } },
              },
            },
          }
        `,
      })
      const cold = await run({
        cwd: root,
        tasks: ['consume'],
        log: logger({ status: [], complete: [], started: [] }),
      })
      expect(cold.ok).toBe(true)
      await rm(path.join(genDir, 'out.txt'))

      const seen: Seen = { status: [], complete: [], started: [] }
      const vanish = vanishOnRestore()
      let warm
      try {
        warm = await run({ cwd: root, tasks: ['consume'], log: logger(seen) })
      } finally {
        vanish.restore()
      }
      expect(vanish.restored).toHaveLength(1)
      expect(warm.ok).toBe(true)
      // codegen's tree is current (no restore); consume's restore vanished.
      expect(seen.complete).toEqual(['gen#codegen cache-hit', 'gen#consume success'])
      expect(await readFile(path.join(genDir, 'out.txt'), 'utf8')).toBe('seed')
      expect(seen.status.filter((l) => l.includes('vanished'))).toEqual([
        expect.stringContaining('gen#consume'),
      ])
    },
    TIMEOUT,
  )
})
