// Scoped config loading: only configs of in-scope projects and their
// transitive dependency closure are evaluated. On a 1090-package
// repo, `vx run one#task` must not pay 1090 config imports — and a
// broken config in an unrelated package must not fail the run.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'

const TIMEOUT = 30_000
let root: string

const silent = (): Logger => ({
  status() {},
  taskStdout() {},
  taskStderr() {},
  taskComplete() {},
})

async function addProject(name: string, config: string, deps: string[] = []): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '0.0.0',
      ...(deps.length
        ? { dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])) }
        : {}),
    }),
  )
  await writeFile(path.join(dir, 'src', 'in.txt'), 'v1')
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
}

const GOOD = `export default { tasks: { build: {
  exec: { command: 'echo ok > out.txt' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
} } }`

const BROKEN = `throw new Error('this config must never be evaluated for out-of-scope runs')`

describe('scoped config loading', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-scoped-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await mkdir(path.join(root, 'packages'), { recursive: true })
    const git = (...a: string[]) => {
      const p = Bun.spawnSync({
        cmd: ['git', '-c', 'commit.gpgsign=false', ...a],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
    }
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'anchored run loads only the target + its dep closure',
    async () => {
      await addProject('lib', GOOD)
      await addProject('app', GOOD, ['lib'])
      await addProject('unrelated', BROKEN)

      // unrelated's config throws on evaluation — the run only
      // succeeds if it was never loaded.
      const r = await run({ cwd: root, tasks: ['app#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['app#build'])
    },
    TIMEOUT,
  )

  it(
    'dep-closure configs ARE loaded (frontier expansion still sees them)',
    async () => {
      await addProject('lib', GOOD)
      await addProject(
        'app',
        `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'echo app > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
        ['lib'],
      )
      const r = await run({ cwd: root, tasks: ['app#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['app#build', 'lib#build'])
    },
    TIMEOUT,
  )

  it(
    'a pkg#task dep loads a project the PACKAGE closure never reaches',
    async () => {
      // `docs` declares no npm dependency on `app`, so `app` is outside
      // `transitiveDeps('docs')`. The cross form deliberately ignores the
      // package graph, so its target's config must still be evaluated.
      await addProject('app', GOOD)
      await addProject(
        'docs',
        `export default { tasks: { build: {
          dependsOn: ['app#build'],
          exec: { command: 'echo docs > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      const r = await run({ cwd: root, tasks: ['docs#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['app#build', 'docs#build'])
    },
    TIMEOUT,
  )

  it(
    'cross-dep loading reaches a fixpoint (a pulled-in config may cross again)',
    async () => {
      await addProject('tools', GOOD)
      await addProject(
        'app',
        `export default { tasks: { build: {
          dependsOn: ['tools#build'],
          exec: { command: 'echo app > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      await addProject(
        'docs',
        `export default { tasks: { build: {
          dependsOn: ['app#build'],
          exec: { command: 'echo docs > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      // Filter scope (not anchored) — the second hop is only reachable if
      // the pre-scan iterates rather than doing a single pass.
      const r = await run({ cwd: root, tasks: ['build'], projects: ['docs'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual([
        'app#build',
        'docs#build',
        'tools#build',
      ])
    },
    TIMEOUT,
  )

  it(
    'a cross-dep target pulls in ITS package closure too',
    async () => {
      // `app` npm-depends on `lib` and declares `^build`. Reaching app via a
      // cross edge must also load lib, or app's frontier finds nothing.
      await addProject('lib', GOOD)
      await addProject(
        'app',
        `export default { tasks: { build: {
          dependsOn: ['^build'],
          exec: { command: 'echo app > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
        ['lib'],
      )
      await addProject(
        'docs',
        `export default { tasks: { build: {
          dependsOn: ['app#build'],
          exec: { command: 'echo docs > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        } } }`,
      )
      const r = await run({ cwd: root, tasks: ['docs#build'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual([
        'app#build',
        'docs#build',
        'lib#build',
      ])
    },
    TIMEOUT,
  )

  it(
    'full-scope runs still surface broken configs',
    async () => {
      await addProject('a', GOOD)
      await addProject('unrelated', BROKEN)
      await expect(run({ cwd: root, tasks: ['build'], log: silent() })).rejects.toThrow(
        /never be evaluated/,
      )
    },
    TIMEOUT,
  )
})
