// What happens when a task's child is killed by a shutdown signal.
//
// `aborted` exists for the Ctrl-C teardown, where vx's own signal handler
// `process.exit`s before any outcome lands — so the status is excluded from
// the tally, the history and the report. But a child can die by SIGTERM /
// SIGINT with no vx teardown at all (a supervisor, an external `kill`,
// `docker stop`, a self-terminating script), and then the run DOES reach its
// summary. Two things must hold on that path:
//
//   1. dependents must not run against the aborted task's PARTIAL outputs —
//      they would cache what they built from them under the exact key a
//      healthy run derives, so the next run serves it as a green hit
//      (tests/stale-hit.test.ts is the sibling file for that failure class);
//   2. the run exits non-zero, so the aborted task must be NAMED — a red
//      exit over a fully green summary that mentions nothing is
//      undiagnosable in CI.
//
// The fixtures self-SIGTERM (`kill -TERM $$`) so the signal arrives without
// vx's handler running: exactly the shape that reaches a summary.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

let root: string

async function write(p: string, content: string): Promise<void> {
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
    const detail = [
      new TextDecoder().decode(p.stderr).trim(),
      new TextDecoder().decode(p.stdout).trim(),
    ]
      .filter((s) => s.length > 0)
      .join(' | ')
    throw new Error(`git ${args.join(' ')} exited ${p.exitCode}: ${detail}`)
  }
}

function vx(cwd: string, ...args: string[]): { out: string; code: number } {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return {
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    code: p.exitCode ?? -1,
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-aborted-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a task killed by a shutdown signal', () => {
  it(
    'does not let its dependents cache what they built from its partial outputs',
    async () => {
      // `a#build` writes PARTIAL, self-SIGTERMs, and would have written
      // COMPLETE. `b#build` consumes a's output. The kill switch is a
      // workspace-root file that is NOT an input of either task, so a's
      // cache key — and therefore b's, which folds a's INPUT key — is
      // IDENTICAL across both runs. Whatever b caches in run 1 is keyed
      // exactly as a healthy run would key it.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await write(path.join(root, '.gitignore'), 'dist/\n.vx/\nkill.flag\n')

      await write(path.join(root, 'packages/a/package.json'), '{"name":"a","version":"0.0.0"}')
      await write(path.join(root, 'packages/a/src/in.txt'), 'a-source')
      await write(
        path.join(root, 'packages/a/vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
               exec: {
                 command:
                   'mkdir -p dist; printf PARTIAL > dist/out.txt; if [ -f ../../kill.flag ]; then kill -TERM $$; sleep 5; fi; printf COMPLETE > dist/out.txt',
               },
             },
           },
         }`,
      )

      await write(
        path.join(root, 'packages/b/package.json'),
        '{"name":"b","version":"0.0.0","dependencies":{"a":"workspace:*"}}',
      )
      await write(path.join(root, 'packages/b/src/in.txt'), 'b-source')
      await write(
        path.join(root, 'packages/b/vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               dependsOn: ['^build'],
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
               exec: { command: 'mkdir -p dist; cat ../a/dist/out.txt > dist/copy.txt' },
             },
           },
         }`,
      )

      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'init')

      await write(path.join(root, 'kill.flag'), '')
      const first = vx(root, 'run', 'build', '--all')
      expect(first.code).not.toBe(0)
      // b never ran, so it cached nothing built from a's partial tree.
      expect(first.out).toMatch(/skipped/)

      // Run 2 is entirely healthy: a completes and writes COMPLETE.
      await rm(path.join(root, 'kill.flag'))
      await rm(path.join(root, 'packages/a/dist'), { recursive: true, force: true })
      await rm(path.join(root, 'packages/b/dist'), { recursive: true, force: true })

      const second = vx(root, 'run', 'build', '--all')
      expect(second.code).toBe(0)
      expect(await readFile(path.join(root, 'packages/a/dist/out.txt'), 'utf8')).toBe('COMPLETE')
      // The whole point: PARTIAL here means run 1's bytes were replayed.
      expect(await readFile(path.join(root, 'packages/b/dist/copy.txt'), 'utf8')).toBe('COMPLETE')
    },
    TIMEOUT,
  )

  it(
    'is named in the summary and the markdown report when the run reaches them',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(path.join(root, '.gitignore'), '.vx/\n')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             fine: { exec: { command: 'echo fine' } },
             doomed: { exec: { command: 'echo working; kill -TERM $$; sleep 5' } },
           },
         }`,
      )
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'init')

      const r = vx(root, 'run', 'fine', 'doomed')
      // Red exit — and the reason has to be on screen.
      expect(r.code).not.toBe(0)
      expect(r.out).toMatch(/Aborted:\s+1 task killed by a shutdown signal/)
      expect(r.out).toMatch(/doomed/)

      const rep = vx(root, 'run', 'fine', 'doomed', '--report=markdown')
      expect(rep.out).toMatch(/1 aborted/)
      expect(rep.out).toMatch(/\|\s*r#doomed\s*\|\s*aborted\s*\|/)
    },
    TIMEOUT,
  )

  it(
    'leaves a run with nothing aborted byte-identical — no section, no report column',
    async () => {
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(path.join(root, '.gitignore'), '.vx/\n')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default { tasks: { fine: { exec: { command: 'echo fine' } } } }`,
      )
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'init')

      const r = vx(root, 'run', 'fine', '--report=markdown')
      expect(r.code).toBe(0)
      expect(r.out).not.toMatch(/Aborted:/)
      expect(r.out).not.toMatch(/aborted/)
    },
    TIMEOUT,
  )
})
