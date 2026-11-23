// How a sandboxed run reports what it touched. Linux: the command runs in
// a process group of its own under vx's observer or strace
// (`ownGroupCommand`), whichever this host can run (`traceFor`). Both
// platforms: SRT's store records, collected per command (`collectRecords`).

import { createConnection } from 'node:net'
import { shellQuote, type SandboxViolation } from '../exec/index.js'
import { observePath } from './seccomp-helper.js'
import { executablePath, helperEnv, taskShell, notify } from '../util/index.js'
import type { SrtModule } from './session.js'

/**
 * The in-sandbox watcher's body: each signal name vx writes down fd 3 goes
 * to the command's group, and the end of the channel (vx closed it once
 * the task exited, or vx is gone) SIGKILLs that group and the watcher's
 * own, the runtime's shells and bridges. The namespace's init then has no
 * child left and exits. bwrap's `--die-with-parent` alone missed: it is
 * set in the namespace only after bwrap's monitor forks it, and a monitor
 * killed in those milliseconds (a `kill -9` of vx, a task stopped as it
 * started) left init, the command and its bridges running under the
 * host's init, the port held, for hours (2026-11-12).
 */
function channelWatch(group: string): string {
  return `while IFS= read -r s; do kill -s "$s" -- "-${group}"; done; kill -s KILL -- "-${group}" 0`
}

/**
 * Linux: the user command in a session, and so a process group, of its
 * own. bwrap's `--new-session` puts the runtime's shells (the proxy
 * bridges' script, the seccomp step's) in ONE group with the command, and
 * `kill 0` reaches a group's members across the nested pid namespace: a
 * command that signalled its own group ended the runtime's shell, bwrap
 * exited 143 and the namespace's teardown SIGKILLed the rest mid-trap
 * (item 751). The shell `exec`s `setsid`, which is no group leader here,
 * so it calls setsid() and execs without a fork: the command keeps the
 * shell's pid, and its status, a signal death included, is the one the
 * runtime waits on.
 *
 * The same group is where a cancellation lands. vx's group signal reaches
 * bwrap's monitor, which dies of it, and the namespace goes with SIGKILL,
 * so vx sends a polite signal's name down fd 3 instead (`signalThrough`)
 * and a watcher forked before the `exec` signals the group, `$$`, with it
 * (item 752). The command runs in the foreground because an `&` command
 * starts with SIGINT ignored, and a shell cannot trap what it inherited
 * ignored. The command does not get fd 3; a caller that passed none
 * forwards nothing, silently.
 *
 * Tools resolve on vx's own PATH; without `setsid` the command keeps the
 * shared group, as before, and `forwards` says the channel is not there.
 */
export function ownGroupCommand(
  tag: string,
  userCommand: string,
  trace?: 'plain' | 'seccomp' | { observer: string },
  tracePaths = false,
): {
  command: string
  forwards: boolean
  traced: boolean
  /** The tracer the command runs under; none where there was no shell to run it. */
  trace: typeof trace
} {
  // `sh`, as an unsandboxed task runs (`runner.ts`): the command ran under
  // bash here, so `[[ … ]]`, brace expansion and `echo 'a\tb'` read one
  // way sandboxed and another unsandboxed or on a remote executor, where
  // `/bin/sh` is dash (item 964).
  let sh: string
  try {
    sh = taskShell()
  } catch {
    return {
      command: `: 'vx-${tag}'; ${userCommand}`,
      forwards: false,
      traced: false,
      trace: undefined,
    }
  }
  const tag0 = `: 'vx-${tag}';`
  let setsid: string | undefined
  try {
    setsid = `${shellQuote(executablePath('setsid'))} `
  } catch {
    setsid = undefined
  }
  if (trace === undefined) {
    const run = `exec ${setsid ?? ''}${shellQuote(sh)} -c ${shellQuote(userCommand)}`
    if (setsid === undefined)
      return { command: `${tag0} ${run}`, forwards: false, traced: false, trace }
    const watch = `{ ${channelWatch('$$')}; } 2>/dev/null <&3 3<&- &`
    return { command: `${tag0} ${watch} ${run} 3<&-`, forwards: true, traced: false, trace }
  }
  // Traced, strace runs INSIDE the sandbox, around the command alone:
  // outside, it followed bwrap building the namespace, a ptrace stop per
  // `openat` of the setup, 17 of a sandboxed `true`'s 45 ms (B-11). It
  // writes to the host's log through descriptor TRACE_FD, which the
  // command's shell closes first, so the task cannot reach the trace.
  // `-DD`: the command keeps the pid it was forked with and strace forks
  // off it into a group of its own, so a `sleep 10 &` the command leaves
  // behind is not a tracee strace waits for: the shell's `wait` ends with
  // the command, the namespace with the shell, and strace goes with it. A tracee stops at each `openat` until strace
  // has written its line, so the kill loses none. `-qq`: nothing of
  // strace's own about the processes it follows.
  // Forked, never `exec`'d: `-DD`'s process waits for ANY child to hear
  // the tracer attached, so one it inherited (the watcher, SRT's network
  // bridges) that exits first sent the command on untraced, and under
  // `--seccomp-bpf` its `execve` failed ENOSYS. A fresh fork has none.
  // POSIX lets an async list start with SIGINT and SIGQUIT ignored, and a
  // shell cannot trap what it was started ignoring: bash 5.2 ignores them
  // for a backgrounded simple command (the first cut here, whose task's
  // `trap … INT` never fired) but not for a brace group, so the `trap -`
  // is for a bash that does; SRT's bash may put them back (dash may not).
  // vx's own observer (`observe/vx-observe.c`) in strace's place: the
  // kernel hands it each call the report reads and no other, where strace
  // stops a new process at every call until its first traced one (3.5 ms
  // of a Bun or Node spawn) and twice at each traced one. It keeps the
  // pid, ends with the command's status, and never passes TRACE_FD on.
  const tracer = (
    typeof trace === 'object'
      ? [trace.observer, String(TRACE_FD), tracePaths ? '1' : '0']
      : [
          executablePath('strace'),
          '-DD',
          '-f',
          ...(trace === 'seccomp' ? ['--seccomp-bpf'] : []),
          // A read through a directory's descriptor (`find`, `grep -r`) names
          // only the entry; `-y` prints the path it opened. 40% slower on 2,000
          // opens, so only where a widened grant's reads are judged.
          ...(tracePaths ? ['-y'] : []),
          '-qq',
          '-e',
          // A process's cwd moves on `chdir` and starts as its parent's at the
          // fork (`deniedCalls`); `?` lets an arch without `fork` skip it.
          TRACED_CALLS,
          '-o',
          `/dev/fd/${TRACE_FD}`,
          '--',
        ]
  )
    .map(shellQuote)
    .join(' ')
  const body = shellQuote(
    typeof trace === 'object' ? userCommand : `exec ${TRACE_FD}>&-; ${userCommand}`,
  )
  const run = `{ trap - INT QUIT; exec ${setsid ?? ''}${tracer} ${shellQuote(sh)} -c ${body} 3<&-; } & c=$!;`
  // Bash reports a job a signal killed on its stderr, the task's: a task
  // whose shell died of SIGKILL printed this whole wrapper (X-111).
  const wait = `wait "$c" 2>/dev/null`
  if (setsid === undefined) {
    return { command: `${tag0} ${run} ${wait}`, forwards: false, traced: true, trace }
  }
  const watch = `{ ${channelWatch('$c')}; } 2>/dev/null <&3 3<&- &`
  return { command: `${tag0} ${run} ${watch} ${wait}`, forwards: true, traced: true, trace }
}

/**
 * What strace stops on: the reads (`openat`, and `open`, musl's open():
 * traced as openat alone, a sibling under a widened write grant was read
 * unreported and cached; arm64 has no `open`; an `openat2` never reaches
 * strace, SRT's write observer takes each one first: `refusedWrites`),
 * the execs and access probes (a refused
 * `./gen.sh || fallback` passed unreported), `readlink` (git hashes a link
 * by its target string: `readlink cfg > out.txt` under a widened grant
 * cached `v1` and replayed it after `cfg` pointed at `v2`; a stop costs
 * ~9 µs, 37 ms on 2,000 links, below the A/A noise on oxlint and vx), and
 * what moves or makes a process's cwd. Not the stat family: a stop per
 * stat cost oxlint 19% and `git status` 30%, where the execs and probes cost nothing measurable, and
 * vx's own no-op run 69% (pr-bench, 495 → 835 ms, 2026-10-23). So a tool
 * that stats before it opens, as Ubuntu 26's cat (uutils) does, refused
 * nothing the trace sees.
 *
 * `rseq` and `set_robust_list` say nothing the report reads: glibc makes
 * each once as a thread starts. strace stops a new thread at EVERY call
 * until the first one its filter traces, so a thread that opens nothing
 * (a pool thread that stats, a GC helper on futex) stopped at each call
 * for life: 3 s of 13 s of the tracer's kernel time on a test file.
 */
const TRACED_CALLS =
  'trace=openat,?open,execve,?access,faccessat,?faccessat2,?readlink,?readlinkat,chdir,fchdir,clone,?clone3,?fork,?vfork,?rseq,?set_robust_list'

/** The descriptor an in-sandbox strace writes its trace to (`ownGroupCommand`). */
const TRACE_FD = 5

/** The records collected for the commands running, by SRT's key for each. */
export const collecting = new Map<string, SandboxViolation[]>()

let collectorOn = false

/**
 * Start collecting SRT's store records for `command`; the returned function
 * stops and hands them over, with `settle` once every record the task's
 * Linux observer (`observer`, its socket) sent is read. The store is a
 * 100-record ring the whole run shares, and on Linux its write observer
 * reports every write any task
 * makes, so a refused write followed by 150 declared ones was gone before
 * the task's exit read it (B-7). One subscription takes each record as it
 * arrives and keeps it only for a command still running. SRT keys a record
 * by the base64 of the command's first 100 characters
 * (`encodeSandboxedCommand`, not exported).
 */
export function collectRecords(
  store: ReturnType<SrtModule['SandboxManager']['getSandboxViolationStore']>,
  command: string,
  observer: string | undefined,
): (settle: boolean) => Promise<SandboxViolation[]> {
  if (!collectorOn) {
    collectorOn = true
    let seen = store.getTotalCount()
    store.subscribe((all) => {
      const total = store.getTotalCount()
      const fresh = Math.min(total - seen, all.length)
      seen = total
      for (const v of fresh > 0 ? all.slice(-fresh) : []) {
        collecting.get(v.encodedCommand ?? '')?.push({ line: v.line, timestamp: v.timestamp })
      }
    })
  }
  const key = Buffer.from(command.slice(0, 100)).toString('base64')
  const list: SandboxViolation[] = []
  collecting.set(key, list)
  return async (settle) => {
    if (settle && observer !== undefined) await observerCaughtUp(observer)
    collecting.delete(key)
    return list
  }
}

/**
 * The Unix socket SRT's Linux write observer listens on, from the command
 * it wrapped (`--setenv SRT_OBSERVE_SOCK <path>`); none when the listener
 * failed or on macOS.
 */
export function observerSocket(wrapped: string): string | undefined {
  return /--setenv SRT_OBSERVE_SOCK (?:'([^']*)'|(\S+))/.exec(wrapped)?.slice(1).find(Boolean)
}

/** `wrapped` without the runtime's write observer: its socket's bind and the variable naming it. */
export function withoutRuntimeObserver(wrapped: string): string {
  const arg = `(?:'[^']*'|\\S+)`
  return wrapped.replace(new RegExp(`--bind (${arg}) \\1 --setenv SRT_OBSERVE_SOCK \\1 `), '')
}

/**
 * Resolves once SRT has read every record sent to `socket` before the call.
 * A task's observer sends its records before the task exits, but they are
 * read when this process gets to that connection: a fixed count of event
 * loop turns after the exit (2) lost 4 of 24 refusals on a loaded CI
 * worker. So a connection of ours goes in after them: the kernel queues
 * connections in order, so SRT accepts it no earlier than the task's, and
 * the task's bytes were already there when it did. SRT's server is not
 * half-open, so it ends ours once it reads our end, and that end coming
 * back means the task's bytes were read first. A socket that is gone
 * answers at once with an error.
 */
function observerCaughtUp(socket: string): Promise<void> {
  return new Promise((resolve) => {
    const conn = createConnection(socket)
    conn.on('connect', () => conn.end())
    conn.on('error', () => resolve())
    conn.on('close', () => resolve())
    conn.resume()
  })
}

/**
 * strace's own message, a line of a traced task's stderr. strace names
 * itself by its argv[0], the absolute path vx runs it by
 * (`/usr/bin/strace: ptrace(PTRACE_LISTEN,…)` on CI), so a bare
 * `strace: ` never matched there and the retry never fired.
 */
export const STRACE_OWN_ERROR = /^(?:[^\s:]*\/)?strace: /

/** The observer's own message (`fail` in `observe/vx-observe.c`), a line of the task's stderr. */
export const OBSERVER_OWN_ERROR = /^vx-observe: (.*)$/

/**
 * Memoized check: is `strace` on PATH on a Linux host, and does it know
 * `--seccomp-bpf` (5.3+)? `'seccomp'` is the fast form; `'plain'` traces
 * every syscall through ptrace and is kept only for an old strace. `why`
 * names what is missing when there is no form, for the warning and for
 * `vx info`.
 */
let straceAvailableCache: Promise<{ form: false | 'plain' | 'seccomp'; why: string }> | undefined

function straceState(): Promise<{ form: false | 'plain' | 'seccomp'; why: string }> {
  if (process.platform !== 'linux') return Promise.resolve({ form: false, why: '' })
  // The promise is the memo, not its answer: a run starts a wave of tasks
  // at once, and each asked before the first answer landed (one probe per task).
  straceAvailableCache ??= probeStrace()
  return straceAvailableCache
}

async function probeStrace(): Promise<{ form: false | 'plain' | 'seccomp'; why: string }> {
  try {
    const p = Bun.spawn([executablePath('strace'), '--version'], {
      env: helperEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(p.stdout).text()
    await p.exited
    if (p.exitCode !== 0) return { form: false, why: `strace --version exited ${p.exitCode}` }
    const m = /version (\d+)\.(\d+)/.exec(out)
    const [major, minor] = m ? [Number(m[1]), Number(m[2])] : [0, 0]
    let form: 'plain' | 'seccomp' = major > 5 || (major === 5 && minor >= 3) ? 'seccomp' : 'plain'
    let refused = await traceRefusal(form)
    // A strace that cannot check the seccomp filter says so and traces on
    // without it, exit 0. Inside the sandbox that line read as the trace
    // cut short, and every sandboxed task ran twice: the plain form, if
    // it is quiet, is the one that works here.
    if (refused?.warned === true && form === 'seccomp') {
      refused = await traceRefusal('plain')
      if (refused === null) form = 'plain'
    }
    return refused === null
      ? { form, why: '' }
      : { form: false, why: `strace cannot trace here (${refused.line})` }
  } catch {
    // Not on PATH. Said as the refused attach is: without it an undeclared
    // read is denied but never reported, so a task that tolerates the miss
    // passes and caches with no word of it (J's lead).
    return { form: false, why: 'strace is not on PATH' }
  }
}

/** How a task's reads are reported: by vx's observer, or by strace with or without its filter. */
export type TraceForm = 'observe' | 'plain' | 'seccomp'

/** Why vx's observer cannot run on this host, null when it can; the promise is the memo. */
let observerCache: Promise<string | null> | undefined

function observerState(): Promise<string | null> {
  observerCache ??= probeObserver()
  return observerCache
}

/** Forget what the strace and observer probes found: the next session asks again. */
export function forgetTraceProbes(): void {
  straceAvailableCache = undefined
  observerCache = undefined
}

/**
 * Where the observer ran on the host and not inside a sandbox, by whether
 * the task set `weakerWhenNested` (another /proc, another outer sandbox).
 * A fact of the host: a reset keeps it.
 */
export const observerRefusedIn = new Map<boolean, string>()

/** A path no host has: the probe's refused read. */
const OBSERVER_PROBE_PATH = '/.vx-observe-probe'

/**
 * One observed shell that opens a path no host has: a kernel before 5.5,
 * a seccomp profile that refuses the listener or a foreign /proc each make
 * the observer say why and exit before it runs anything, and a build that
 * runs but reports nothing (an architecture no test of ours ran on) is
 * not trusted either: the refused open must be in its report.
 * `debug.strace` asks for strace.
 */
async function probeObserver(): Promise<string | null> {
  // A bool read here as `debug.dumpable` is in util.
  const strace = process.env['VX_DEBUG_STRACE']
  if (strace === 'true' || strace === '1') return 'VX_DEBUG_STRACE is set'
  const observer = await observePath()
  if (observer === undefined) return 'no build of it for this machine'
  try {
    const p = Bun.spawn(
      [observer, '1', '0', taskShell(), '-c', `true <${OBSERVER_PROBE_PATH}; exit 0`],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: helperEnv() },
    )
    const [report, err, exit] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    const said = err.split('\n').find((l) => OBSERVER_OWN_ERROR.test(l))
    if (said !== undefined) return OBSERVER_OWN_ERROR.exec(said)![1]!
    if (exit !== 0) return `its probe exited ${exit}`
    return report.includes(`"${OBSERVER_PROBE_PATH}", O_RDONLY) = -1 ENOENT`)
      ? null
      : 'its probe reported no refused read'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** The tracer a task of this kind runs under, or false where none can; the loss is said once. */
export async function traceFor(weakerNested: boolean): Promise<false | TraceForm> {
  if (process.platform !== 'linux') return false
  if ((await observerState()) === null && !observerRefusedIn.has(weakerNested)) return 'observe'
  const { form, why } = await straceState()
  if (form === false && why !== '') warnUntraced(why)
  return form
}

/**
 * Why a sandboxed task on this host runs without the report of the reads
 * the sandbox denied, or null when it is traced (or the host is not
 * Linux, where the report does not come from strace). Says nothing on
 * stderr: `vx info` reports it as a fact (B-51's lead).
 */
export async function untracedReason(): Promise<string | null> {
  if (process.platform !== 'linux') return null
  if ((await observerState()) === null && observerRefusedIn.size === 0) return null
  const { why } = await straceState()
  return why === '' ? null : why
}

/**
 * Why strace may not attach here (null when it may), asked once with the flags a task's trace
 * uses (`ownGroupCommand`). A strace that exits 0 having said something of
 * its own is refused too (`warned`): in a task, its line is the retry key. `--version` answers on a host that refuses
 * ptrace (Yama's `ptrace_scope` 2 or 3, a container's seccomp profile),
 * and there every sandboxed task failed twice, the retry included, on
 * `attach: ptrace(PTRACE_SEIZE…): Operation not permitted`. Refused, the
 * run goes untraced, as without strace: bwrap still enforces, and only the
 * read-violation report is lost, which is said once.
 */
async function traceRefusal(
  form: 'plain' | 'seccomp',
): Promise<{ line: string; warned: boolean } | null> {
  const p = Bun.spawn(
    [
      executablePath('strace'),
      '-DD',
      '-f',
      ...(form === 'seccomp' ? ['--seccomp-bpf'] : []),
      '-qq',
      '-e',
      TRACED_CALLS,
      '-o',
      '/dev/null',
      '--',
      executablePath('true'),
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: helperEnv() },
  )
  const err = await new Response(p.stderr).text()
  const line = err.split('\n').find((l) => STRACE_OWN_ERROR.test(l))
  if ((await p.exited) === 0) return line === undefined ? null : { line, warned: true }
  return { line: err.trim().split('\n')[0] || `exit ${p.exitCode}`, warned: false }
}

let warnedNoTrace = false

/** Said once per process: why sandboxed tasks run untraced, and what that loses. */
function warnUntraced(why: string): void {
  if (warnedNoTrace) return
  warnedNoTrace = true
  notify({
    kind: 'line',
    tone: 'warn',
    text:
      `[vx] sandbox: ${why}, so sandboxed tasks run without the report of the reads the sandbox denied; ` +
      `the sandbox still enforces\n`,
  })
}
