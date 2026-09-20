// The watch loop's end-to-end fixture, shared by the `watch-loop*` suites:
// markers rather than sleeps. "watching" on stdout means every watcher has
// proved delivery, and an execution count kept OUTSIDE the workspace says
// how many times the task's command actually ran (a cache hit runs
// nothing). One fresh workspace per case: an `app` whose cached `build`
// concatenates `src/*.txt` into `dist/out.txt` and appends a line to the
// count outside.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach } from 'bun:test'
import { addProject, makeWorkspace } from './workspace.js'

export const BIN = path.resolve(import.meta.dir, '..', '..', 'src', 'bin.ts')
export const SETTLE_MS = 1_000

export interface Watch {
  proc: ReturnType<typeof Bun.spawn>
  out: () => string
  /** The watch's stderr. Its notices go here, not to stdout — and a pipe nobody drains can block the child. */
  err: () => string
  cycles: () => number
}

export async function until(
  cond: () => Promise<boolean> | boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export async function executions(log: string): Promise<number> {
  const f = Bun.file(log)
  if (!(await f.exists())) return 0
  return (await f.text()).split('\n').filter((l) => l === 'run').length
}

/** The initial run and nothing after it — on a miss, the watch's own output says which label re-ran. */
export async function initialOnly(w: Watch, log: string): Promise<void> {
  const n = await executions(log)
  if (n !== 1) {
    throw new Error(
      `expected the initial run only (1 execution), saw ${n}; watch output:\n${w.out()}`,
    )
  }
}

/**
 * How this watch is delivering events, read off vx's OWN announcement
 * rather than guessed from the platform.
 *
 * `armWatcher` falls back to polling when no OS event arrives within its
 * probe window, and a container without a working inotify (this repo's
 * cloud gate, 2026-09-20) takes that path for every case. It matters to
 * the counts: under events a task's undeclared write arrives as its own
 * event one window after the run, costing a redundant cycle; under a
 * 250 ms poll the edit and the write land in the same sample, so the
 * follower never happens and the same scenario settles one execution
 * earlier. Both settle — which is what these suites exist to prove — so
 * the rows assert the count for the mode they actually ran in.
 *
 * Read it AFTER the watching marker: the fallback announces itself
 * first, so by then the line is there or it never will be. The notice is
 * on STDERR, which is why the fixture drains that too.
 */
export function deliveryMode(w: Watch): 'events' | 'polling' {
  return w.err().includes('no OS watch events within') ? 'polling' : 'events'
}

export function startWatch(root: string, select: readonly string[] = ['--all']): Watch {
  const proc = Bun.spawn([process.execPath, BIN, 'watch', 'build', ...select], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, VX_KILL_GRACE_MS: '200' },
  })
  let out = ''
  let err = ''
  void (async () => {
    for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
  })()
  void (async () => {
    for await (const chunk of proc.stderr) err += new TextDecoder().decode(chunk)
  })()
  return {
    proc,
    out: () => out,
    err: () => err,
    cycles: () => out.split('re-running...').length - 1,
  }
}

export interface WatchFixture {
  /** The workspace root. */
  root: string
  /** The `app` project's directory. */
  dir: string
  /** The execution count, outside the workspace so no watcher sees it. */
  log: string
  /** The case's watch, if it started one; the fixture ends it. */
  watch: Watch | undefined
}

/** Registers the per-case workspace on the calling `describe`; read the fields inside a case, never at load. */
export function useWatchFixture(): WatchFixture {
  const f: WatchFixture = { root: '', dir: '', log: '', watch: undefined }
  let outside = ''
  beforeEach(async () => {
    f.root = await makeWorkspace({ prefix: 'vx-watch-loop-' })
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-watch-count-'))
    f.log = path.join(outside, 'runs.log')
    f.dir = await addProject(
      f.root,
      'app',
      `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && cat src/*.txt > dist/out.txt && echo run >> ${f.log}' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
    )
    await mkdir(path.join(f.dir, 'src'), { recursive: true })
    await writeFile(path.join(f.dir, 'src', 'a.txt'), 'a1\n')
  })
  afterEach(async () => {
    if (f.watch !== undefined) {
      f.watch.proc.kill('SIGTERM')
      await f.watch.proc.exited
      f.watch = undefined
    }
    await rm(f.root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  return f
}
