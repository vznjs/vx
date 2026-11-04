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
// to `left` before this exits with the tool's own code.
//
// A watch runs its phases: once the tool has been quiet (no task mark for
// QUIET_MS), the next phase's edits are made; the marks written in each
// phase are listed in `watch.out`. Then the group gets SIGINT.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { constants } from 'node:os'

interface Options {
  stop?: { signal: NodeJS.Signals; when: string; ignored?: boolean; again?: string }
  left?: string
  /** The tool's stdin is a pipe this holds open and never writes. */
  openStdin?: boolean
  watch?: {
    phases: { write?: Record<string, string | null>; sh?: string }[]
    marks: string[]
    out: string
  }
}

/** How long no task mark means the watch is idle: past every tool's debounce and a tiny task. */
const QUIET_MS = 3_000
/** How long one phase may take before it is cut short. */
const PHASE_MS = 60_000

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

if (stop) {
  const deadline = Date.now() + 30_000
  while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) {
    if (existsSync(stop.when)) break
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
      if (existsSync(stop.again)) break
      await Bun.sleep(20)
    }
    signal()
  }
}

const running = (): boolean => proc.exitCode === null && proc.signalCode === null

if (opts.watch) {
  const { phases, marks, out } = opts.watch
  const read = (): string =>
    marks.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')).join('')
  let seen = ''
  const slices: string[] = []
  // Quiet: no new mark for QUIET_MS (the first phase also waits for one).
  const settle = async (needsRun: boolean): Promise<void> => {
    let last = read()
    let since = Date.now()
    const deadline = Date.now() + PHASE_MS
    while (running() && Date.now() < deadline) {
      await Bun.sleep(100)
      const now = read()
      if (now !== last) {
        last = now
        since = Date.now()
      } else if (Date.now() - since >= QUIET_MS && (!needsRun || now.length > seen.length)) break
    }
    slices.push(last.slice(seen.length))
    seen = last
  }
  await settle(true)
  for (const phase of phases) {
    if (!running()) break
    for (const [rel, content] of Object.entries(phase.write ?? {})) {
      if (content === null) rmSync(rel, { recursive: true, force: true })
      else {
        mkdirSync(path.dirname(rel), { recursive: true })
        writeFileSync(rel, content)
      }
    }
    if (phase.sh) Bun.spawnSync(['sh', '-c', phase.sh], { stdio: ['ignore', 'inherit', 'inherit'] })
    await settle(false)
  }
  writeFileSync(out, JSON.stringify(slices))
  try {
    process.kill(-proc.pid, 'SIGINT')
  } catch {
    // the group is gone
  }
  const deadline = Date.now() + 20_000
  while (running() && Date.now() < deadline) await Bun.sleep(50)
  if (running()) process.kill(-proc.pid, 'SIGKILL')
}

await proc.exited

// A process still alive a second after the tool exits is one it left
// behind; one on its way out (a helper reaping what is left) is not.
function alive(): string[] {
  const self = String(process.pid)
  return readdirSync('/proc')
    .filter((p) => /^\d+$/.test(p) && p !== '1' && p !== self)
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
