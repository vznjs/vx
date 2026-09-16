// A reader that leaves is not the run's failure (item 231). `vx run … |
// head -1` closes the pipe after the first task's line; the writes that
// follow get EPIPE, which Bun raises as an `error` event on the stream and,
// unheard, as an uncaught exception — the run died with a stack after its
// task had succeeded, exit 1, its lock directory left behind. bin.ts
// listens; the run finishes, saves, releases and exits with its verdict.
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { runLockPath } from '../src/orchestrator/run-lock.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

// `first` ends at once, so its line reaches the pipe and `head` leaves;
// `second` ends well after, so its line and the summary meet the closed
// pipe. A single instant task would land everything before `head` exits
// and prove nothing.
const CONFIG = `
  export default {
    tasks: {
      first: { exec: { command: 'true' } },
      second: {
        exec: { command: 'sleep 1.5 && mkdir -p dist && echo hi > dist/out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

/** `set -o pipefail; vx … | head -1`: the pipeline's code is vx's own. */
async function vxIntoHead(cwd: string): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(
    [
      'bash',
      '-c',
      'set -o pipefail; "$@" | head -1 >/dev/null',
      'sh',
      process.execPath,
      BIN,
      'run',
      'first',
      'second',
      '--all',
    ],
    { cwd, stdout: 'ignore', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } },
  )
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, err }
}

describe('bin.ts: a reader that leaves does not fail the run', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-reader-gone-' })
    await addProject(root, 'app', { config: CONFIG, files: { 'src/index.js': 'export {}\n' } })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exits with its own verdict, without a stack, saves, and releases its lock', async () => {
    const r = await vxIntoHead(root)
    expect(r.err).not.toContain('EPIPE')
    expect(r.code).toBe(0)
    expect(existsSync(runLockPath(root))).toBe(false)
    // The run that lost its reader still saved: the next one finds its
    // outputs current (the no-op needs the fingerprint the save recorded).
    const again = Bun.spawnSync([process.execPath, BIN, 'run', 'second', '--all'], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
    })
    expect(again.exitCode).toBe(0)
    expect(`${again.stdout.toString()}${again.stderr.toString()}`).toMatch(/up-to-date|hit/)
  }, 30_000)
})
