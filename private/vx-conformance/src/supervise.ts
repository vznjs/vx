// Runs a tool inside the sandbox the way a terminal or a supervisor does,
// for a step that stops a run or asks what it left behind:
//
//   bun supervise.ts '<json>' <argv...>
//
// The tool gets a process group of its own, as a shell's foreground job
// does. A stop sends its signal to that group once the `when` file exists,
// as Ctrl-C reaches the foreground group. A process still alive in the
// sandbox's PID namespace a second after the tool exits, other than this
// one and the namespace's init, is one the run left behind: it is written
// to `left` before this exits with the tool's own code. Unboxed (a tool in
// its own sandbox), the processes of the run are those carrying its tag and
// what they started, not every process of the host.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
import { runProcesses, TAG } from './sandbox.ts'

interface Options {
  /** `waitMs`: how long to wait for `when` before the signal goes anyway (default 30 s). */
  stop?: {
    signal: NodeJS.Signals
    when: string
    ignored?: boolean
    again?: string
    waitMs?: number
    /** Absolute globs of directories mirroring the workspace, where `when` and `again` may appear first. */
    mirrors?: string[]
  }
  left?: string
  /** The tool's stdin is a pipe this holds open and never writes. */
  openStdin?: boolean
}

// What the tool leaves behind is re-parented here, not to the host's init,
// so on the host's /proc (a sandbox case) it is still found among this
// process's descendants.
if (process.platform === 'linux') {
  const { dlopen, FFIType } = await import('bun:ffi')
  const PR_SET_CHILD_SUBREAPER = 36
  dlopen('libc.so.6', {
    prctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  }).symbols.prctl(PR_SET_CHILD_SUBREAPER, 1)
}

const [json, ...argv] = process.argv.slice(2)
const opts: Options = JSON.parse(json!)
const stop = opts.stop

// `nohup` hands the tool the signal ignored, which an exec keeps.
const cmd = stop?.ignored
  ? ['sh', '-c', `trap '' ${stop.signal.slice(3)}; exec "$@"`, 'sh', ...argv]
  : argv
const proc = Bun.spawn(cmd, {
  stdio: [opts.openStdin ? 'pipe' : 'ignore', 'inherit', 'inherit'],
  detached: true,
})

/** Whether a workspace file a task makes exists, in the tree or in a mirror of it. */
const seen = (rel: string, mirrors: string[] = []): boolean =>
  existsSync(rel) ||
  mirrors.some(
    (m) =>
      !new Bun.Glob(path.join(m, rel).slice(1))
        .scanSync({ cwd: '/', onlyFiles: false, dot: true })
        .next().done,
  )

if (stop) {
  const deadline = Date.now() + (stop.waitMs ?? 30_000)
  while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) {
    if (seen(stop.when, stop.mirrors)) break
    await Bun.sleep(20)
  }
  const signal = (): void => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    try {
      process.kill(-proc.pid, stop.signal)
    } catch {
      // the group is gone: the tool exited in between
    }
  }
  signal()
  if (stop.again) {
    const again = Date.now() + 30_000
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < again) {
      if (seen(stop.again, stop.mirrors)) break
      await Bun.sleep(20)
    }
    signal()
  }
}

await proc.exited

// A process still alive a second after the tool exits is one it left
// behind; one on its way out (a helper reaping what is left) is not.
function alive(): string[] {
  const self = String(process.pid)
  const tag = process.env[TAG]
  const run = tag === undefined ? null : new Set(runProcesses(process.pid, `${TAG}=${tag}`))
  // The bwrap that started this carries the tag too: it is the harness's, not the run's.
  for (let p = process.ppid; p > 1 && run !== null; p = parentOf(p)) run.delete(p)
  return readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p) && p !== '1' && p !== self && (run?.has(Number(p)) ?? true))
    .flatMap((p) => {
      try {
        const stat = readFileSync(`/proc/${p}/stat`, 'utf8')
        if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return []
        return [readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0').join(' ').trim()]
      } catch {
        return []
      }
    })
}

function parentOf(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
  } catch {
    return 0
  }
}

if (opts.left) {
  let left = alive()
  for (let i = 0; i < 20 && left.length > 0; i++) {
    await Bun.sleep(50)
    left = alive()
  }
  writeFileSync(opts.left, JSON.stringify(left))
}

const signo = proc.signalCode ? constants.signals[proc.signalCode as NodeJS.Signals] : undefined
process.exit(signo !== undefined ? 128 + signo : (proc.exitCode ?? 1))
