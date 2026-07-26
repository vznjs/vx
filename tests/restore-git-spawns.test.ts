// Restore-path git-spawn behavior. A warm run that restores outputs
// must NOT re-spawn `git ls-files` per project when downstream input
// globs can't see the restored paths (the universal src→dist layout).
// When the globs DO overlap the outputs, the re-spawn fallback keeps
// gitignore semantics byte-identical — pinned by the no-re-execution
// stamp assertion in the second test.
//
// The CLI is spawned as a real subprocess because executable PATH
// resolution happens in the child; a shim dir prepended to its PATH
// counts every git invocation.

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const TIMEOUT = 60_000
const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')

interface Fixture {
  root: string
  shimDir: string
  gitLog: string
}

let fixture: Fixture

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-gitspawn-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await mkdir(path.join(root, 'packages'), { recursive: true })

  const shimDir = path.join(root, '.gitshim')
  const gitLog = path.join(shimDir, 'calls.log')
  await mkdir(shimDir, { recursive: true })
  const realGit = Bun.which('git')
  await writeFile(
    path.join(shimDir, 'git'),
    `#!/bin/sh\necho "$@" >> ${gitLog}\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  )

  const git = (...args: string[]) => {
    const p = Bun.spawnSync({
      cmd: [realGit!, '-c', 'commit.gpgsign=false', ...args],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr))
  }
  git('init', '-q')
  git('config', 'user.email', 'test@vx.local')
  git('config', 'user.name', 'vx test')

  return { root, shimDir, gitLog }
}

async function addProject(root: string, name: string, testInputs: string): Promise<void> {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'src', 'in.txt'), 'v1')
  await writeFile(
    path.join(dir, 'vx.config.mjs'),
    `export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && echo built > dist/out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
        },
        test: {
          dependsOn: ['build'],
          exec: { command: 'echo ran >> ../../.stamp-${name}' },
          cache: { inputs: { files: ${testInputs} }, outputs: { files: [] } },
        },
      },
    }
    `,
  )
}

async function vx(f: Fixture, shimmed: boolean): Promise<number> {
  const p = Bun.spawn({
    cmd: [process.execPath, BIN, 'run', 'build', 'test', '--all'],
    cwd: f.root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(shimmed ? { PATH: `${f.shimDir}${path.delimiter}${process.env.PATH ?? ''}` } : {}),
    },
  })
  return await p.exited
}

async function lsFilesCount(f: Fixture): Promise<number> {
  const text = await readFile(f.gitLog, 'utf8').catch(() => '')
  return text.split('\n').filter((l) => l.includes('ls-files')).length
}

async function stampLines(f: Fixture, name: string): Promise<number> {
  const text = await readFile(path.join(f.root, `.stamp-${name}`), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).length
}

async function warmThenWipe(f: Fixture): Promise<void> {
  expect(await vx(f, false)).toBe(0)
  for (const p of ['a', 'b']) {
    await rm(path.join(f.root, 'packages', p, 'dist'), { recursive: true, force: true })
  }
  await rm(f.gitLog, { force: true })
}

describe('restore-path git spawns', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })

  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'no per-project re-spawn when downstream globs cannot match restored outputs',
    async () => {
      await addProject(fixture.root, 'a', `['src/**']`)
      await addProject(fixture.root, 'b', `['src/**']`)
      await warmThenWipe(fixture)

      expect(await vx(fixture, true)).toBe(0)
      // Tasks were all cache-hits: the stamp files did not grow.
      expect(await stampLines(fixture, 'a')).toBe(1)
      expect(await stampLines(fixture, 'b')).toBe(1)
      // Exactly the one bulk workspace snapshot (which is two `ls-files`
      // calls — the `-s --others` enumeration plus the index-only `-v` probe
      // for skip-worktree flags, issued concurrently). Restores must not
      // trigger a PER-PROJECT ls-files when `src/**` can't see `dist/`; that
      // O(N) regression is what this guards.
      expect(await lsFilesCount(fixture)).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'overlapping globs keep the re-spawn fallback (and stay cache-hits)',
    async () => {
      // `**` matches the restored dist files, so the snapshot must be
      // refreshed through git (gitignore semantics) — same as before
      // the optimization. The cold run's test key already saw dist via
      // the post-save re-spawn, so the warm run must be a clean hit; a
      // stale snapshot here would surface as a spurious re-execution.
      await addProject(fixture.root, 'a', `['**']`)
      await addProject(fixture.root, 'b', `['**']`)
      await warmThenWipe(fixture)

      expect(await vx(fixture, true)).toBe(0)
      expect(await stampLines(fixture, 'a')).toBe(1)
      expect(await stampLines(fixture, 'b')).toBe(1)
      // Bulk snapshot (2 calls, see above) + one re-spawn per project whose
      // test globs overlap the restored outputs. The per-project fallback is
      // a single spawnSync, so it adds one each.
      expect(await lsFilesCount(fixture)).toBe(4)
    },
    TIMEOUT,
  )
})
