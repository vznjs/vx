// Which tasks a `vx run` invocation actually selects.
//
// Two failure modes pinned here, both of the "exits 0 having silently
// not done what you asked" class:
//   1. a requested name that matches no project is dropped whenever
//      ANOTHER requested name resolves (`vx run build typo`);
//   2. an explicitly anchored `pkg#task` is cancelled when a
//      co-requested BARE task's filter selects nothing.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { resolveRunOptions, parseRunArgs } from '../src/cli/index.js'

const TIMEOUT = 30_000
let root: string

function silent(): Logger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    status(m: string) {
      lines.push(m)
    },
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
}

function git(...a: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...a],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
}

async function addProject(name: string, tasks: string[]): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  await writeFile(path.join(dir, 'src', 'in.txt'), 'v1')
  const body = tasks
    .map(
      (t) => `${t}: {
        exec: { command: 'echo ${t} > ${t}.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['${t}.txt'] } },
      }`,
    )
    .join(',\n')
  await writeFile(path.join(dir, 'vx.config.mjs'), `export default { tasks: { ${body} } }`)
}

describe('task selection', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-select-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    await mkdir(path.join(root, 'packages'), { recursive: true })
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a bogus BARE task fails the run even when another task resolves',
    async () => {
      await addProject('a', ['build'])
      const log = silent()
      const r = await run({ cwd: root, tasks: ['build', 'totallybogus'], log })
      expect(r.ok).toBe(false)
      expect(r.outcomes).toEqual([])
      expect(log.lines.join('\n')).toContain('No projects declare task(s): totallybogus.')
    },
    TIMEOUT,
  )

  it(
    'a bogus ANCHORED task fails the run even when another task resolves',
    async () => {
      await addProject('a', ['build'])
      const log = silent()
      const r = await run({ cwd: root, tasks: ['build', 'a#totallybogus'], log })
      expect(r.ok).toBe(false)
      expect(log.lines.join('\n')).toContain('No projects declare task(s): a#totallybogus.')
    },
    TIMEOUT,
  )

  it(
    'an anchored task naming an unknown PROJECT fails the run',
    async () => {
      await addProject('a', ['build'])
      const log = silent()
      const r = await run({ cwd: root, tasks: ['build', 'nosuchpkg#build'], log })
      expect(r.ok).toBe(false)
      expect(log.lines.join('\n')).toContain('No projects declare task(s): nosuchpkg#build.')
    },
    TIMEOUT,
  )

  it(
    'a bare task declared by only SOME projects stays green (sparse tasks are normal)',
    async () => {
      await addProject('a', ['build', 'lint'])
      await addProject('b', ['build'])
      const r = await run({ cwd: root, tasks: ['build', 'lint'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['a#build', 'a#lint', 'b#build'])
    },
    TIMEOUT,
  )

  it(
    'every requested name resolving runs them all',
    async () => {
      await addProject('a', ['build', 'test'])
      const r = await run({ cwd: root, tasks: ['build', 'test'], log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['a#build', 'a#test'])
    },
    TIMEOUT,
  )

  it(
    'an EMPTY project scope never reports a bare task as unresolved',
    async () => {
      // The "nothing changed" selection outcome: the scope is empty, so
      // no bare name can resolve. That is not a typo, and the CLI's
      // selection layer (not this guard) owns the message.
      await addProject('a', ['build'])
      const log = silent()
      const r = await run({ cwd: root, tasks: ['build'], projects: [], log })
      expect(r.ok).toBe(false)
      // The generic empty-graph message, NOT a per-name accusation.
      expect(log.lines.join('\n')).toContain('No projects declare task(s): build.')
    },
    TIMEOUT,
  )

  it(
    'an anchored task still runs when a co-requested bare task selects nothing',
    async () => {
      await addProject('a', ['build'])
      git('add', '-A')
      git('commit', '-qm', 'init')

      // `--affected=HEAD` selects nothing (clean tree at HEAD). The bare
      // `build` has no scope left — but `a#build` was named explicitly.
      const parsed = parseRunArgs(['a#build', 'build', '--affected=HEAD', '--force'])
      expect(parsed.error).toBeUndefined()
      const resolved = await resolveRunOptions(parsed, root, parsed.tasks)
      expect('nothingSelected' in resolved).toBe(false)
      expect('error' in resolved).toBe(false)
      if ('error' in resolved || 'nothingSelected' in resolved) throw new Error('unreachable')

      const r = await run({ ...resolved, log: silent() })
      expect(r.ok).toBe(true)
      expect(r.outcomes.map((o) => o.node.id)).toEqual(['a#build'])
    },
    TIMEOUT,
  )

  it(
    'a bare-only invocation whose filter selects nothing still exits clean',
    async () => {
      await addProject('a', ['build'])
      git('add', '-A')
      git('commit', '-qm', 'init')

      const parsed = parseRunArgs(['build', '--affected=HEAD'])
      const resolved = await resolveRunOptions(parsed, root, parsed.tasks)
      expect('nothingSelected' in resolved).toBe(true)
    },
    TIMEOUT,
  )
})
