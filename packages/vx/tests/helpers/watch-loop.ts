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
const LOCKED_BIN = path.resolve(import.meta.dir, 'vx-locked.ts')
export const SETTLE_MS = 1_000
/** Rows, not CI's full blocks: the suites count a task's row per cycle, and CI sets these. */
export const NOT_CI = { CI: '', GITHUB_ACTIONS: '' }

/** `debug.watch`: each arm said on stderr, the sync point after a cycle that re-read the set. */
export const ARMS = { VX_DEBUG_WATCH: '1' }
/** How many times the loop has armed (the first included), under `ARMS`. */
export const arms = (w: Watch, projects?: number): number =>
  w
    .err()
    .split(
      projects === undefined
        ? 'vx watch: armed '
        : `vx watch: armed ${projects} project${projects === 1 ? '' : 's'}\n`,
    ).length - 1

/**
 * Whether a cycle's run warned `line`. A run's warnings go to stderr (they
 * left stdout so `vx run > log` keeps only output), as one bare line; the
 * watch's own config reads say theirs tagged `! vx`, so only the run's is
 * the whole line.
 */
export const runWarned = (w: Watch, line: string): boolean => w.err().split('\n').includes(line)

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

// `deliveryMode` lived here (item 418) so a row could assert the execution
// count for the delivery mode it actually ran in: three under events, two
// under the polling fallback. Its explanation for the two — the edit and
// the task's own write landing in the same 250 ms sample — was a plausible
// cause nobody had measured, and item 482 refutes it. The poller never
// sampled the write at all: `POLL_SKIP` refused to descend into `dist`
// whether or not a task declared it as an output. With the poller reading
// the run's own ignore filter the two modes report the same tree, the rows
// assert one number, and nothing needs to ask which watcher is running.

export function startWatch(
  root: string,
  select: readonly string[] = ['--all'],
  env: Record<string, string> = {},
  task = 'build',
): Watch {
  const proc = Bun.spawn([process.execPath, LOCKED_BIN, 'watch', task, ...select], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...NOT_CI, VX_TEST_KILL_GRACE: '200ms', ...env },
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
    cycles: () => out.split('\n').filter((l) => l.startsWith('changed ')).length,
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
              inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
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
