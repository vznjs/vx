// Child-process invocation + resource accounting.
//
// Uses Bun.spawn so we get .resourceUsage() (cpuTime, maxRSS) after the
// process exits. cpuMs / peakRssBytes are then surfaced on RunResult and
// folded into the v11 `runs` table by the orchestrator.

import type { Pointer } from 'bun:ffi'
import { closeSync, existsSync, readFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import {
  formatBytes,
  shellArgv,
  isExecutableMissing,
  isOutOfFds,
  killGraceMs,
  OUT_OF_FDS_HINT,
  testTimerMs,
  helperEnv,
  type SecretMask,
} from '../util/index.js'
import {
  closeSignalChannel,
  holdGroups,
  killTree,
  releaseGroup,
  releaseServerGroup,
  signalThrough,
  guardLine,
  spawnGuarded,
  untilGroupsGone,
} from './kill-tree.js'

/** `sh` names itself in its errors. */
const SH_ARGV0 = { argv0: 'sh' }

export interface RunResult {
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  /** The signal that killed the child, if any (Bun's `signalCode`): its
   *  name, or its number when it has none (Linux's real-time signals).
   *  SIGINT/SIGTERM here means a Ctrl-C / shutdown teardown — the
   *  orchestrator reverts such a task to aborted, not failed. */
  signal?: string | number
  /** True when vx's own `timeout` timer fired and SIGTERMed the child.
   *  Distinguishes a timeout (a real `failed`) from a Ctrl-C shutdown
   *  SIGTERM (which the orchestrator reverts to `aborted`). */
  timedOut?: boolean
  /** Total user+system CPU time for the child, in milliseconds. */
  cpuMs?: number
  /** Peak resident set size for the child, in bytes. */
  peakRssBytes?: number
  /** `Bun.spawn` threw: no shell ran, so its 127 is vx's and says nothing
   *  about the command (A-41). */
  spawnFailed?: true
  /** The shell exited while a process it started still held its
   *  stdout/stderr past the drain bound (`POST_EXIT_CUT_LINE`): that process
   *  may still write the task's outputs, so the result is not saved. */
  leftRunning?: true
}

/**
 * Which streams `runCommand` retains into `RunResult.stdout` / `.stderr`.
 * Both default to true — the primitive's contract is that those fields hold
 * what the child wrote, and a field that silently lies is worse than one
 * that costs. A caller that will not READ a stream opts down here: the live
 * `onStdout` / `onStderr` callbacks still fire for every chunk, so only the
 * retained string is dropped. Retaining a stream nothing reads costs its
 * full byte size in heap, for the whole task.
 */
export interface CaptureConfig {
  stdout?: boolean
  stderr?: boolean
}

export interface RunOptions {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Extra args appended to the command (shell-quoted). For arg forwarding. */
  forwardArgs?: readonly string[] | undefined
  /** Called for each chunk of stdout/stderr as it arrives, for live output. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** See `CaptureConfig`. Omitted → both streams retained (today's behaviour). */
  capture?: CaptureConfig
  /**
   * Upper bound (ms) on the child's run time. When it elapses the
   * child is SIGTERMed and the result is flagged `timedOut`. Undefined
   * → no limit.
   */
  timeoutMs?: number
  /**
   * Run-scoped registry of in-flight subprocesses. The child is added
   * on spawn and removed once it exits, so the orchestrator's signal
   * handler can SIGTERM everything still alive mid-run.
   */
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  /** Told the child's pid once it is spawned (telemetry samples its tree). */
  onSpawn?: (pid: number) => void
  /**
   * Hand the child vx's own stdin, stdout and stderr (`exec.interactive` on
   * a TTY). Nothing passes through vx: the callbacks hear nothing and the
   * result's streams are empty.
   */
  terminal?: boolean
}

type Fd = 'inherit' | 'ignore' | 'pipe' | number

/** A child's descriptors 0–2: vx's own for a task that holds the terminal. */
function taskStdio(terminal: boolean | undefined, pipes: TaskPipes): [Fd, Fd, Fd] {
  return terminal === true ? ['inherit', 'inherit', 'inherit'] : [pipes.stdin, ...pipes.stdio]
}

const O_NONBLOCK = 0o4000
const O_CLOEXEC = 0o2000000
const F_SETFL = 4
const F_SETPIPE_SZ = 1031
/**
 * A pipe holds 64 KiB by default, and a 200 MB stdout drained 13% slower
 * through one than through Bun's socketpair (min of 7: 293 vs 259 ms);
 * at 256 KiB it drained in 230. Past the user's pipe quota the kernel
 * refuses the resize and the pipe keeps its 64 KiB.
 */
const PIPE_BYTES = 256 * 1024

type PipeCalls = {
  pipe2: (fds: Pointer, flags: number) => number
  fcntl: (fd: number, cmd: number, arg: number) => number
  ptr: (view: Int32Array, byteOffset?: number) => Pointer
}
let pipeCalls: PipeCalls | null | undefined

/** libc's `pipe2` and `fcntl`, bound once; null off Linux or where libc will not load. */
function linuxPipeCalls(): PipeCalls | null {
  if (pipeCalls !== undefined) return pipeCalls
  pipeCalls = null
  if (process.platform !== 'linux') return null
  try {
    // Loaded at the first spawn, not with the module: a static import cost
    // every vx start 0.3 ms, a warm run that spawns nothing included.
    const { dlopen, FFIType, ptr } = require('bun:ffi') as typeof import('bun:ffi')
    // glibc's soname; musl's loader answers any `libc.` name with itself
    // (ldso/dynlink.c's reserved names).
    const { symbols } = dlopen('libc.so.6', {
      pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    })
    pipeCalls = { pipe2: symbols.pipe2, fcntl: symbols.fcntl, ptr }
  } catch {
    // Bun's socketpair, as before: only `/dev/stdout` by path fails on it.
  }
  return pipeCalls
}

/**
 * Two pipes, `[out read, out write, err read, err write]`, or undefined
 * when libc is not bound or a descriptor is not to be had (Bun's own
 * socketpair then fails the spawn with the reason).
 */
function realPipes(): Int32Array | undefined {
  const calls = linuxPipeCalls()
  if (calls === null) return undefined
  const fds = new Int32Array(4)
  // Bun's spawn closes every descriptor it is not handed (probed, Bun
  // 1.4.2); O_CLOEXEC keeps any other exec from holding a write end open.
  if (calls.pipe2(calls.ptr(fds), O_CLOEXEC) !== 0) return undefined
  if (calls.pipe2(calls.ptr(fds, 8), O_CLOEXEC) !== 0) {
    closeSync(fds[0]!)
    closeSync(fds[1]!)
    return undefined
  }
  // vx's ends only: a task whose stdout is non-blocking fails its writes with EAGAIN.
  calls.fcntl(fds[0]!, F_SETFL, O_NONBLOCK)
  calls.fcntl(fds[2]!, F_SETFL, O_NONBLOCK)
  calls.fcntl(fds[0]!, F_SETPIPE_SZ, PIPE_BYTES)
  calls.fcntl(fds[2]!, F_SETPIPE_SZ, PIPE_BYTES)
  return fds
}

/** One pipe, `[read, write]`, both close-on-exec, or undefined as {@link realPipes}. */
function heldPipe(): Int32Array | undefined {
  const calls = linuxPipeCalls()
  if (calls === null) return undefined
  const fds = new Int32Array(2)
  return calls.pipe2(calls.ptr(fds), O_CLOEXEC) === 0 ? fds : undefined
}

/**
 * A task's stdout and stderr. Bun's `'pipe'` is a socketpair, and Linux
 * opens `/dev/stdout` through `/proc/self/fd/1`, which a socket refuses
 * (ENXIO): `echo x > /dev/stdout` and `cmd | tee /dev/stderr` failed in
 * every task, where a terminal or Turbo hands real pipes (X-113). So on
 * Linux vx makes the pipes (`pipe2` through `bun:ffi`) and hands the child
 * the write ends. macOS opens `/dev/fd/N` as a dup of the descriptor,
 * which a socket allows, so Bun's pipe stays there.
 *
 * `held`: stdin is a pipe vx keeps open and never writes (a persistent
 * task's, schema.md), for the same reason: `cat /dev/stdin` on Bun's
 * socketpair failed with ENXIO instead of blocking. Otherwise `'ignore'`.
 */
export class TaskPipes {
  /** Descriptor 0 for `Bun.spawn`'s `stdio`. */
  readonly stdin: number | 'pipe' | 'ignore'
  /** Descriptors 1 and 2 for `Bun.spawn`'s `stdio`. */
  readonly stdio: readonly [number | 'pipe', number | 'pipe']
  readonly #read: readonly number[]
  readonly #stdinWrite: number | undefined

  constructor(terminal?: boolean, held?: boolean) {
    const fds = terminal === true ? undefined : realPipes()
    this.stdio = fds === undefined ? ['pipe', 'pipe'] : [fds[1]!, fds[3]!]
    this.#read = fds === undefined ? [] : [fds[0]!, fds[2]!]
    const inFds = held === true && terminal !== true ? heldPipe() : undefined
    this.stdin = held !== true ? 'ignore' : inFds === undefined ? 'pipe' : inFds[0]!
    this.#stdinWrite = inFds?.[1]
  }

  /**
   * Close vx's copies of the child's ends once the spawn has returned or
   * thrown: the child holds its own, and a write end left here is a writer
   * the reader's EOF would wait for.
   */
  spawned(): void {
    for (const fd of [this.stdin, ...this.stdio]) if (typeof fd === 'number') closeSync(fd)
  }

  /** The child's stdout and stderr. */
  streams(
    child: ReturnType<typeof Bun.spawn>,
  ): [
    ReadableStream<Uint8Array> | number | undefined,
    ReadableStream<Uint8Array> | number | undefined,
  ] {
    const [out, err] = this.#read
    return out === undefined
      ? [child.stdout, child.stderr]
      : [Bun.file(out).stream(), Bun.file(err!).stream()]
  }

  /**
   * Close the read ends, once both streams have ended or been cancelled.
   * Bun reads a dup of each, but takes it on the stream's first pull: a
   * number closed before then was reused by the next spawn's pipe, and
   * the stream read THAT (probed, Bun 1.4.2).
   */
  close(): void {
    for (const fd of this.#read) closeSync(fd)
  }

  /**
   * Close the held stdin's write end, once the child has exited and its
   * output has ended. Not with the output alone: a server that sends it
   * to a log (`exec >log 2>&1`) ended its streams at once, read stdin EOF
   * and exited.
   */
  closeStdin(): void {
    if (this.#stdinWrite !== undefined) closeSync(this.#stdinWrite)
  }
}

/**
 * Read the terminal's modes before a task that holds it runs, and return
 * what puts them back once it exits: a task killed in raw mode (or one
 * that never undid its `stty raw -echo`) left the user's terminal with no
 * echo and no Ctrl-C. Bun restores them at exit only when vx's stdout is
 * the terminal, so `vx run … > log` kept them, and the rest of a run
 * printed in them. `detached`, as the task is: a vx in a background job
 * would be stopped by SIGTTOU on the set.
 */
function keepTerminalModes(): (() => void) | undefined {
  const saved = stty('-g')
  if (saved === undefined) return undefined
  const restore = (): void => {
    if (!owed.delete(restore)) return
    if (stty('-g') !== saved) stty(saved)
  }
  owed.add(restore)
  return restore
}

/** The modes of every task still holding the terminal, owed back on its exit. */
const owed = new Set<() => void>()

/**
 * Put the terminal back now for every task still holding it: vx is
 * exiting without waiting for them (a second signal, signals.ts), so the
 * restore on each task's exit never runs.
 */
export function restoreTerminalModes(): void {
  for (const restore of [...owed]) restore()
}

function stty(arg: string): string | undefined {
  try {
    const out = Bun.spawnSync(['stty', arg], {
      env: helperEnv(),
      stdio: ['inherit', 'pipe', 'ignore'],
      detached: true,
    })
    return out.success ? out.stdout.toString().trim() : undefined
  } catch {
    // No stty: the modes stay the task's, as before.
    return undefined
  }
}

export function shellQuote(arg: string): string {
  if (arg === '') return `''`
  // A `#` opens a comment only at a word's start, so `app#build` stays bare.
  if (/^[A-Za-z0-9_\-.,/=:@%+][A-Za-z0-9_\-.,/=:@%+#]*$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * One pass over `command` as sh reads it. `comment`: where a comment still
 * open at the end starts, or -1 — a `#` opens one only unquoted and at the
 * start of a word (`a#b`, `$#` and `${#x}` are words), and a newline closes
 * it. `body`: per line, is it a heredoc's body or terminator (`<<X` /
 * `<<-'X'` / `<<\X` … `X`). One scan, because each needs the other: a
 * `<<X` in a comment or quotes opens no heredoc, and a quote in a body
 * opens nothing (X-110).
 */
function shellShape(command: string): { comment: number; body: boolean[]; subshell: boolean } {
  const lines = command.split('\n')
  const body = lines.map(() => false)
  const pending: Array<{ delim: string; tabs: boolean }> = []
  // Per open `(`: does it open a subshell, not `$(`, `$((`, `<(` or `f()`.
  const parens: boolean[] = []
  let subshell = false
  let quote = ''
  let comment = -1
  let atWordStart = true
  let line = 0
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === '\n') {
      line++
      comment = -1
      if (quote !== '') continue
      atWordStart = true
      // A heredoc's body starts on the line after its `<<`.
      while (pending.length > 0 && line < lines.length) {
        const text = lines[line]!
        body[line] = true
        const open = pending[0]!
        if ((open.tabs ? text.replace(/^\t+/, '') : text) === open.delim) pending.shift()
        i += text.length + 1
        line++
      }
      continue
    }
    if (comment >= 0) continue
    if (quote === "'") {
      if (c === "'") quote = ''
      continue
    }
    if (c === '\\') {
      if (command[i + 1] === '\n') line++
      else atWordStart = false
      i++
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = ''
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      atWordStart = false
      continue
    }
    if (c === '#' && atWordStart) {
      comment = i
      continue
    }
    if (c === '<' && command[i - 1] !== '<') {
      // The delimiter is a whole word, quotes removed: `<<END-OF` and
      // `<<'a b'` end at `END-OF` and `a b`. One opening with a digit is
      // left alone, for `$((x<<2))`.
      const m = /^<<(-?)[ \t]*((?:[^\s;&|()<>'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+)/.exec(
        command.slice(i, i + 256),
      )
      if (m !== null && !/^\d/.test(m[2]!)) {
        const delim = m[2]!.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g, (_, s, d, e) =>
          s !== undefined ? s : d !== undefined ? d.replace(/\\(.)/g, '$1') : e,
        )
        pending.push({ delim, tabs: m[1] === '-' })
        i += m[0].length - 1
        atWordStart = false
        continue
      }
    }
    if (c === '(') {
      const prev = command[i - 1] ?? ''
      parens.push(!/[$<>\w]/.test(prev) && !(prev === '(' && parens.at(-1) === false))
    } else if (c === ')') {
      const opened = parens.pop()
      if (i === command.length - 1) subshell = opened === true
    }
    atWordStart = /[\s;&|()<>]/.test(c)
  }
  return { comment, body, subshell }
}

/**
 * The command a task runs with the args after `--` appended, shell-quoted.
 * They go before a trailing comment: appended after it, `echo args: # show`
 * ran without them and said nothing (item 1060). Trailing blanks go first.
 */
export function withForwardArgs(command: string, args: readonly string[] | undefined): string {
  if (!args || args.length === 0) return command
  // A command that ends in a heredoc's body: appended to its terminator,
  // `X FWD` closed nothing and the args never reached the command (X-12).
  // They go on the last line that is a command, where `cat <<X FWD` is
  // still `cat FWD` reading the heredoc.
  const trimmed = command.trimEnd()
  const lines = trimmed.split('\n')
  const shape = shellShape(trimmed)
  if (shape.body[lines.length - 1] === true) {
    const last = shape.body.lastIndexOf(false)
    const tail = lines.slice(last + 1).join('\n')
    return `${withForwardArgs(lines.slice(0, last + 1).join('\n'), args)}\n${tail}`
  }
  const quoted = args.map(shellQuote).join(' ')
  // Of the trimmed command: the newline closing a template literal's last
  // line closed its comment too, and `echo args: # c\n` took the args into
  // the comment (X-110).
  let comment = shape.comment
  if (comment < 0) {
    // A command that ends in a newline (a template literal's closing line)
    // ran the args as a command of their own: `--watch: not found`. Kept
    // when an odd run of backslashes ends it: that escapes what follows.
    const escaped = (/\\+$/.exec(trimmed)?.[0].length ?? 0) % 2 === 1
    // So did one that ends in a lone `;` or `&` (or a case arm's `;;`): the
    // args go before it. An escaped one (find's `-exec … \;`) is a word,
    // and takes them after.
    const sep = /(?:^|[^;&|<>\\])(?:\\\\)*(;;|[;&])$/.exec(trimmed)?.[1]
    // After a compound command's closer they were a syntax error
    // (`(cmd) --fix`, `fi --fix`): they go to the last command inside it.
    // A closer word counts only where a command starts, after a separator.
    const closer = shape.subshell
      ? ')'
      : /(?:^|[^\\])(?:\\\\)*[;&\n][ \t]*(fi|done|esac|\})$/.exec(trimmed)?.[1]
    const end = sep ?? closer
    if (end !== undefined) {
      const head = trimmed.slice(0, -end.length).trimEnd()
      return `${withForwardArgs(head, args)}${trimmed.slice(head.length)}`
    }
    return `${escaped ? command : trimmed} ${quoted}`
  }
  // A comment-only last line after a commented line: the args go before
  // the earliest comment, or they land inside it (`echo one # c\n# two`).
  for (let c = comment; c >= 0; c = shellShape(trimmed.slice(0, c).trimEnd()).comment) comment = c
  // What precedes the comment may end in a heredoc: the args go where they
  // would with no comment, never on its terminator.
  const head = trimmed.slice(0, comment).trimEnd()
  const gap = trimmed.slice(head.length, comment) || ' '
  return `${withForwardArgs(head, args)}${gap}${trimmed.slice(comment)}`
}

// Any shell control/expansion character means the wrapping `sh` has real
// work to do (chaining, pipes, redirects, globbing, variables, subshells,
// backgrounding) and must stay resident.
const SHELL_CONTROL = /[&|;<>(){}$`\n\\!*?~]/

// Shell builtins run INSIDE sh — `exec <builtin>` fails (there's no
// external `exit`/`true`/`echo`). They also spawn no grandchild, so
// there's nothing to gain by exec-wrapping them.
const SHELL_BUILTINS = new Set([
  'exit',
  'true',
  'false',
  ':',
  'echo',
  'cd',
  'export',
  'set',
  'unset',
  'read',
  'test',
  '[',
  'printf',
  'pwd',
  'umask',
  'wait',
  'trap',
  'eval',
  'exec',
  'source',
  '.',
  'alias',
  'unalias',
  'type',
  'hash',
  'jobs',
  'kill',
  'shift',
  'return',
  'break',
  'continue',
  'local',
  'readonly',
  'times',
  'ulimit',
  'command',
  'builtin',
  'let',
  'declare',
  'typeset',
  // The rest of bash's builtins, as `compgen -b` lists them.
  'bg',
  'bind',
  'caller',
  'compgen',
  'complete',
  'compopt',
  'dirs',
  'disown',
  'enable',
  'fc',
  'fg',
  'getopts',
  'help',
  'history',
  'logout',
  'mapfile',
  'popd',
  'pushd',
  'readarray',
  'shopt',
  'suspend',
  // bash's reserved words that may open a one-line command; macOS's `sh`
  // is bash, and `exec [[ … ]]` there is "exec: [[: not found".
  '[[',
  'time',
])

/**
 * Prepend `exec ` to a command that is a single EXTERNAL program (no
 * shell control characters, not a builtin, no leading env-assignment).
 * `exec` REPLACES the wrapping `sh` with the program: `resourceUsage`
 * measures the program itself rather than the shell, a signal lands on
 * the program directly, and there is one process fewer per task.
 * (Until kill-tree.ts this was also what kept a single command's real
 * process from orphaning on a teardown; the process group covers every
 * shape now.) Compound commands, builtins, and `FOO=bar cmd` forms keep
 * the shell.
 */
export function execWrap(command: string): string {
  const first = execWord(command)
  return first === undefined ? command : `exec ${command}`
}

/**
 * The one program a command runs when it is a plain `word args…` — the
 * word `execWrap` execs, and the word the shell names in "not found" when
 * it exits 127. Undefined for a pipeline, a builtin, an assignment: there
 * the 127 could be any segment's.
 */
export function execWord(command: string): string | undefined {
  if (SHELL_CONTROL.test(command)) return undefined
  // The word as the shell reads it: quotes group and are removed, so
  // `"./my tool.sh"` names one file (the verdict looked for `"./my`).
  const raw = command.trimStart()
  let first = ''
  let quote = ''
  let i = 0
  for (; i < raw.length; i++) {
    const c = raw[i]!
    if (quote !== '') {
      if (c === quote) quote = ''
      else first += c
    } else if (c === "'" || c === '"') quote = c
    else if (/\s/.test(c)) break
    else first += c
  }
  if (quote !== '' || first === '' || raw.slice(0, i).includes('=')) return undefined
  return SHELL_BUILTINS.has(first) ? undefined : first
}

/**
 * POSIX shells report signal death as 128 + signal number (SIGTERM →
 * 143, SIGKILL → 137). Bun gives the signal's NAME, or since 1.4.4 its
 * number when the signal has no name; `os.constants` maps a name to
 * the platform-correct number. Unknown names fall back to 130 (128 +
 * SIGINT).
 */
export function signalExitCode(signal: string | number): number {
  if (typeof signal === 'number') return 128 + signal
  const num = (osConstants.signals as Partial<Record<string, number>>)[signal]
  return num === undefined ? 130 : 128 + num
}

/**
 * The signal a run's stop sends a task, from its abort reason: a task
 * stopped before its spawn exits as if that signal had killed it. As
 * `forwardedSignal` (orchestrator/signals.ts): a hang-up forwards SIGTERM
 * (to many servers SIGHUP means "reload"), so it reads as SIGTERM here.
 */
export function stopSignal(reason: unknown): 'SIGINT' | 'SIGTERM' {
  return reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
}

/**
 * The reverse: the signal an exit above 128 stands for (137 → SIGKILL),
 * by the platform's numbering; undefined for a plain exit. The shell
 * reports 128 + n for a death by signal n, so the read is the shell's
 * convention, not proof — a command may exit 137 on its own.
 */
export function exitSignal(code: number): string | undefined {
  if (code <= 128 || code >= 128 + 65) return undefined
  const signals = osConstants.signals as Partial<Record<string, number>>
  const num = code - 128
  return Object.keys(signals).find((k) => signals[k] === num && !SIGNAL_ALIASES.has(k))
}

// Second names for one number (SIGIOT = SIGABRT, SIGPOLL = SIGIO); the
// canonical one reads.
const SIGNAL_ALIASES = new Set(['SIGIOT', 'SIGPOLL', 'SIGCLD'])

/**
 * Grace after a timeout SIGTERM before escalating to SIGKILL — a child that
 * ignores SIGTERM must still be bounded. Matches the persistent-shutdown grace.
 */
const TIMEOUT_SIGKILL_GRACE_MS = 2000

/**
 * Run `fn` one loop turn later, once the child exits already pending are
 * read. A deadline due in the same turn as a child's exit fires BEFORE Bun
 * reaps it: a task that exited 0 inside its timeout, seen late by a busy vx,
 * was SIGTERMed as a zombie and failed as timed out, and a server that died
 * before ready read as a readiness timeout (2026-10-08). A turn later the
 * exit has settled the caller, which clears the returned timer.
 */
function afterPendingExits(fn: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(fn, 0)
}

/**
 * Arm a SIGTERM timeout on a spawned child. Returns a handle whose
 * `timedOut()` reports whether the timer fired — so the caller can
 * classify the resulting SIGTERM as a real failure rather than a
 * Ctrl-C abort — and `settle()`, awaited once the child has exited:
 * it cancels the timers and, when the timeout fired, waits out the rest
 * of the grace for the child's GROUP and SIGKILLs whoever is left. The
 * shell dying on the SIGTERM is not the tree dying: a backgrounded
 * process that ignores it lived on under init after vx exited (nx#11782's
 * sibling, reproduced on vx 2026-09-24). A no-op (never fires, nothing
 * to settle) when `timeoutMs` is undefined.
 */
export function armTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number | undefined,
): { timedOut: () => boolean; settle: () => Promise<void> } {
  if (timeoutMs === undefined) return { timedOut: () => false, settle: async () => {} }
  let firedAt: number | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const graceMs = killGraceMs(TIMEOUT_SIGKILL_GRACE_MS)
  let timer = setTimeout(() => {
    timer = afterPendingExits(fire)
  }, timeoutMs)
  function fire(): void {
    firedAt = Date.now()
    killTree(proc, 'SIGTERM')
    // Escalate to SIGKILL after a grace: a child that TRAPS+IGNORES SIGTERM
    // (`trap '' TERM`) would otherwise defeat the timeout entirely and hang
    // `await proc.exited` until its natural exit — there is no run-level
    // timeout, so a wedged child hangs the whole run forever. Mirrors the
    // end-of-run persistent-shutdown escalation. Unref'd so it never keeps
    // the CLI alive.
    killTimer = setTimeout(() => killTree(proc, 'SIGKILL'), graceMs)
    killTimer.unref?.()
  }
  return {
    timedOut: () => firedAt !== undefined,
    settle: async () => {
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (firedAt === undefined) return
      const left = await untilGroupsGone([proc], Math.max(0, firedAt + graceMs - Date.now()))
      for (const child of left) killTree(child, 'SIGKILL')
    },
  }
}

/**
 * Grace after the direct child exits before we abort the stdout/stderr readers.
 * The pipe reaches EOF only when EVERY write-end fd is closed, so a task that
 * backgrounds a process inheriting fd 1/2 (`server & echo up` — `execWrap`
 * leaves compound commands as `sh -c`, so `sh` exits while the grandchild holds
 * the pipe) never EOFs. On a clean exit with no lingering writer the pipe EOFs
 * at once, so the readers win this race immediately and normal tasks pay
 * nothing; only a stuck reader waits out the grace. Residual buffered output is
 * bounded by the OS pipe buffer (streamToString drains continuously DURING the
 * run), so this is far longer than any real drain needs. What the leftover
 * process writes after the bound is lost, and `POST_EXIT_CUT_LINE` says so.
 */
const POST_EXIT_DRAIN_MS = 250

/**
 * The line a task's frame gets when the drain bound cut its pipes. The cut
 * was silent: a backgrounded child's late output vanished from the frame and
 * the cached replay with no word (nx#35302 reproduced on vx, 2026-09-24).
 * The bound stays, since it is what keeps a leftover server from hanging the
 * run; the line makes the loss visible.
 */
export const POST_EXIT_CUT_LINE =
  `[vx] output after the task's shell exited was cut: a process it left running ` +
  `still held its stdout/stderr ${POST_EXIT_DRAIN_MS} ms later\n`

/**
 * How long one stream's output waits on the other's open line. dash writes
 * the pieces of `sh: 1: cannot open /dev/tty: …` back to back; a line open
 * longer is a prompt or a progress line, and the other stream's lines are
 * shown live rather than held behind it.
 */
export const OPEN_LINE_WAIT_MS = 50
/** And how much of it waits: the hold never costs more than this per task. */
export const OPEN_LINE_HOLD_CHARS = 64 * 1024

/**
 * A task's two output callbacks, merged a line at a time. They are two
 * pipes, read in the order they arrive, and dash's stderr line written in
 * pieces took a stdout write inside it: `sh: /dev/ttyNO-TTY\n\n` (CI,
 * 2026-10-29). So a chunk on one stream waits while the other's line is
 * open, and goes once that line ends; what of a chunk follows its last
 * newline goes after the held output. Past `OPEN_LINE_WAIT_MS`,
 * `OPEN_LINE_HOLD_CHARS` or `end` it goes as written, the line unbroken:
 * a newline put there became the stream's own text, and a hit replays
 * each stream to its own descriptor (`2> log` read one the task never
 * wrote). `own` breaks the line before vx's own text only. A stream
 * writing alone is never held, so a task that writes one stream pays a
 * comparison per chunk. An absent callback stays absent (nothing decodes).
 */
export function lineEnds(
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void,
): {
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** `text` on a line of its own. */
  own(text: string): string
  /** Lets what waits go: the task's streams ended. */
  end(): void
} {
  // A test lengthens it to drive the hold itself on a loaded runner, where
  // a `sleep` between two writes outlasted 50 ms (macOS CI, PR #4867).
  const waitMs = testTimerMs('OPEN_LINE_WAIT', OPEN_LINE_WAIT_MS)
  const sinks = [onStdout, onStderr]
  /** The stream whose line is open (0 stdout, 1 stderr). */
  let open: 0 | 1 | undefined
  /** What the other stream wrote while that line was open: one side at most. */
  const held = ['', '']
  /** When what waits began to: the bound counts from there. */
  let heldAt = 0
  // One timer, re-armed only when it fires early: a hold set and cleared
  // its own per line, and a task interleaving short lines paid a timer each
  // (+26 ms of CPU on 20 000 lines, 2026-10-29).
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number): void => {
    timer = setTimeout(due, ms)
    timer.unref()
  }
  const due = (): void => {
    timer = undefined
    const s = held[0]!.length > 0 ? 0 : held[1]!.length > 0 ? 1 : undefined
    if (s === undefined) return
    const left = heldAt + waitMs - performance.now()
    if (left > 0) arm(left)
    else release(s)
  }
  const write = (s: 0 | 1, text: string): void => {
    open = text.endsWith('\n') ? undefined : s
    sinks[s]?.(text)
  }
  const release = (s: 0 | 1): void => {
    const text = held[s]!
    if (text.length === 0) return
    held[s] = ''
    write(s, text)
  }
  const push = (s: 0 | 1, chunk: string): void => {
    if (chunk.length === 0) return
    if (open === undefined || open === s) {
      const other = s === 0 ? 1 : 0
      const nl = held[other]!.length === 0 ? -1 : chunk.lastIndexOf('\n')
      if (nl === -1 || nl === chunk.length - 1) {
        write(s, chunk)
        if (nl !== -1) release(other)
        return
      }
      write(s, chunk.slice(0, nl + 1))
      release(other)
      return push(s, chunk.slice(nl + 1))
    }
    if (held[s]!.length === 0) heldAt = performance.now()
    held[s] += chunk
    if (held[s]!.length > OPEN_LINE_HOLD_CHARS) return release(s)
    if (timer === undefined) arm(waitMs)
  }
  return {
    ...(onStdout && { onStdout: (chunk: string) => push(0, chunk) }),
    ...(onStderr && { onStderr: (chunk: string) => push(1, chunk) }),
    own: (text) => (open !== undefined ? `\n${text}` : text),
    end: () => {
      clearTimeout(timer)
      timer = undefined
      release(0)
      release(1)
    },
  }
}

/**
 * After the direct child has exited, wait for the stdout/stderr readers to
 * reach EOF — but bound it: an orphaned grandchild holding the pipe open would
 * hang the run forever (there is no default task timeout). If the grace expires
 * first, abort the reader signal so `streamToString` cancels its read and
 * returns whatever it captured, and resolve true: the caller adds
 * `POST_EXIT_CUT_LINE` to the task's stderr. The timer is unref'd so it can
 * never keep the CLI alive after the readers settle (the plugin-flush
 * lesson); it is not cleared, because a late resolve on a race already won
 * by the drain changes nothing (item 636 deleted the clear and nothing
 * reddened).
 */
export async function drainOrAbort(
  streams: Promise<unknown>,
  ac: AbortController,
): Promise<boolean> {
  const deadline = new Promise<'timeout'>((resolve) => {
    setTimeout(() => resolve('timeout'), POST_EXIT_DRAIN_MS).unref?.()
  })
  const winner = await Promise.race([streams.then(() => 'drained' as const), deadline])
  if (winner === 'timeout') ac.abort()
  return winner === 'timeout'
}

/**
 * Upper bound on the text a `readyWhen` regex is tested against. The matcher
 * normally keeps only the trailing partial line, so this bites only when the
 * stream has no line breaks at all.
 */
const READY_MATCH_WINDOW_CHARS = 64 * 1024

/**
 * Terminal escapes a `readyWhen` pattern is matched without: CSI (colour,
 * cursor), OSC (titles, links), charset picks (`tput sgr0` writes
 * `\x1b(B\x1b[m`) and the two-byte forms. Vite under
 * `FORCE_COLOR` prints `\x1b[1mLocal\x1b[22m:`, which `Local:` never matched
 * (item 1059). The streamed bytes keep them; only the tested text drops them.
 */
const TERMINAL_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex -- ESC is the point
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]+[0-~]|[@-Z\\-_])/g

/**
 * Why a persistent task never became ready — the reason every label and
 * record reads instead of a fabricated exit (item 270). `exitCode` is the
 * child's own when it exited before the pattern matched.
 */
export class PersistentReadyError extends Error {
  readonly reason: 'timeout' | 'exited' | 'spawn'
  readonly exitCode: number | undefined
  constructor(message: string, reason: 'timeout' | 'exited' | 'spawn', exitCode?: number) {
    super(message)
    this.name = 'PersistentReadyError'
    this.reason = reason
    this.exitCode = exitCode
  }
}

export interface PersistentSpawn {
  /**
   * Underlying Bun subprocess so the orchestrator can SIGTERM it later;
   * undefined when the spawn itself failed and `ready` has rejected.
   */
  child: ReturnType<typeof Bun.spawn> | undefined
  /**
   * Resolves once the task is considered "ready":
   *   - immediately on successful spawn when no `readyWhen` is given,
   *   - on the first stdout/stderr line that matches `readyWhen`.
   * Rejects with the spawn error if the child fails to start.
   */
  ready: Promise<void>
  /** ms from spawn to ready, to the readiness timeout giving up, or to now. */
  readyMs: () => number
}

// `capture` is a `runCommand` concept: a persistent task never returns a
// RunResult (it is handed back at READY, still running), so there is no
// retained string to opt out of. Its output reaches the caller only through
// the live callbacks.
export interface PersistentOptions extends Omit<RunOptions, 'forwardArgs' | 'capture'> {
  /**
   * String regex. The first stdout/stderr line that matches signals
   * "ready". Undefined → ready immediately on spawn.
   */
  readyWhen?: string
  /**
   * Bound the readiness wait: if `readyWhen` hasn't matched within
   * this window, the child is SIGTERMed and `ready` rejects. Only
   * meaningful together with `readyWhen` (a ready-on-spawn task
   * resolves before the timer can fire).
   */
  timeoutMs?: number
  /**
   * Spawn it with fd 3 as its signal channel and route its polite signals
   * there (`signalThrough`): a Linux sandboxed command, whose group signal
   * would kill bwrap instead (`wrapSandboxedCommand`'s `forwardsSignals`).
   */
  signalChannel?: boolean
}

/**
 * Spawn a long-running task. Unlike `runCommand`, this returns once
 * the task is *ready* (per `readyWhen`) — not when it exits. The
 * caller owns the returned `child` and must SIGTERM it during
 * cleanup. Stdout/stderr keep streaming into the live `onStdout` /
 * `onStderr` callbacks for the whole lifetime of the child.
 */
export function runPersistent(opts: PersistentOptions): PersistentSpawn {
  const start = Date.now()
  let readyAt: number | undefined
  // When the readiness wait gave up: the wait's length, not the kill grace
  // a TERM-trapping server runs out after it.
  let gaveUpAt: number | undefined

  // Pattern compiled once; thrown errors surface synchronously so the
  // caller can wrap with a user-facing message.
  const readyRe = opts.readyWhen !== undefined ? new RegExp(opts.readyWhen) : undefined

  let child: ReturnType<typeof Bun.spawn>
  const pipes = new TaskPipes(opts.terminal, true)
  const restoreModes = opts.terminal === true ? keepTerminalModes() : undefined
  try {
    const signalFd = opts.signalChannel === true
    child = spawnGuarded((guard) =>
      Bun.spawn(
        shellArgv(
          (guard === undefined ? '' : guardLine(signalFd ? 4 : 3)) + execWrap(opts.command),
        ),
        {
          ...SH_ARGV0,
          cwd: opts.cwd,
          env: opts.env as Record<string, string>,
          // A pipe vx holds and never writes: stdin stays open while vx
          // lives and ends when it does. A dev server that exits on stdin
          // EOF (esbuild --watch, Vite's case in turborepo#8915) became ready
          // and exited 0 under 'ignore'. Not the terminal unless the task
          // asks (`terminal`, one per run): several servers would steal each
          // other's keystrokes, and a CI's /dev/null stdin is the same EOF.
          // The one-shot spawn below keeps 'ignore', so a task that reads
          // stdin can never hang CI.
          stdio: [
            ...taskStdio(opts.terminal, pipes),
            ...(signalFd ? ['pipe' as const] : []),
            ...(guard === undefined ? [] : [guard]),
          ],
          // Its own session and process group, so a kill reaches what it
          // forked (kill-tree.ts). The terminal, when it is handed over, is
          // not this session's controlling one, so no read stops the group.
          detached: true,
        },
      ),
    )
    if (restoreModes !== undefined) void child.exited.then(restoreModes)
    if (signalFd) {
      signalThrough(child, child.stdio[3] as number)
      const spawned = child
      void spawned.exited.then(() => closeSignalChannel(spawned))
    }
  } catch (err) {
    pipes.close()
    pipes.closeStdin()
    // Bun names `sh` in the ENOENT a missing directory gives too.
    // The command the shell was handed, a sandbox's wrap included.
    const message =
      isExecutableMissing(err) && !existsSync(opts.cwd)
        ? `its working directory ${opts.cwd} does not exist`
        : spawnErrorReason(err, opts.signalChannel === true ? SANDBOXED_TASK : 'task', opts.command)
    return {
      child: undefined,
      ready: Promise.reject(
        new PersistentReadyError(`failed to spawn persistent task: ${message}`, 'spawn'),
      ),
      readyMs: () => Date.now() - start,
    }
  } finally {
    pipes.spawned()
  }

  let resolveReady!: () => void
  let rejectReady!: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const markReady = (): void => {
    // A marker printed on the way down, once the wait gave up, is not ready.
    if (readyAt === undefined && gaveUpAt === undefined) {
      readyAt = Date.now()
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      resolveReady()
    }
  }

  // Stream readers. Each stream owns a pending fragment so a regex
  // match isn't missed across chunk boundaries. The pattern is tested
  // against each line on its own — without its break and without terminal
  // escapes — so `^` and `$` anchor to a line as a user reads it; a whole
  // fragment holding `booting\nready\n` failed `^ready` and `ready$`
  // alike (item 1059). `\r` ends a line too: a progress bar's frames are
  // lines to a reader. The trailing partial line is tested as well —
  // prompt-style markers ("Listening on :3000" with no newline) would
  // never resolve ready under complete-lines-only matching.
  const readyLine = (re: RegExp, line: string): boolean =>
    re.test(line.includes('\x1b') ? line.replace(TERMINAL_ESCAPE_RE, '') : line)
  const consumeChunks = async (
    stream: ReadableStream<Uint8Array> | number | undefined,
    isStderr: boolean,
  ): Promise<void> => {
    if (!stream || typeof stream === 'number') return
    let fragment = ''
    const handleChunk = (chunk: string): void => {
      if (chunk.length === 0) return
      // Chunks are forwarded, never retained. The one consumer of a
      // persistent task's text is the logger, which keeps its OWN bounded
      // tail fed from these same callbacks (registered at taskStart, so it
      // covers the pre-ready window too) — a second copy here was read by
      // nobody.
      if (isStderr) opts.onStderr?.(chunk)
      else opts.onStdout?.(chunk)
      if (readyRe && readyAt === undefined) {
        fragment += chunk
        let start = 0
        for (let i = 0; i < fragment.length; i++) {
          const c = fragment.charCodeAt(i)
          if (c !== 10 && c !== 13) continue
          if (readyLine(readyRe, fragment.slice(start, i))) {
            markReady()
            fragment = ''
            return
          }
          start = i + 1
        }
        fragment = fragment.slice(start)
        if (readyLine(readyRe, fragment)) {
          markReady()
          fragment = ''
          return
        }
        // Dropping complete lines assumes the stream HAS line breaks. Output
        // with none is one endless line, so the fragment would become a
        // third unbounded accumulator (measured 464 MiB in 6 s, and the
        // per-chunk `test` over an ever-growing string makes it quadratic
        // in CPU too). Keep the most RECENT window: a match may span the
        // chunk boundary, and no readiness marker is anywhere near this
        // long.
        if (fragment.length > READY_MATCH_WINDOW_CHARS) {
          fragment = fragment.slice(fragment.length - READY_MATCH_WINDOW_CHARS)
        }
      }
    }
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        handleChunk(decoder.decode(value, { stream: true }))
      }
      // Flush any undecoded multi-byte tail when the stream closes so
      // the buffered text (and a final-fragment match) stay complete.
      handleChunk(decoder.decode())
    } finally {
      reader.releaseLock()
    }
  }

  // Wire up readers. We deliberately don't await them — they run for
  // the child's lifetime. The `ready` promise resolves out-of-band.
  const [stdout, stderr] = pipes.streams(child)
  const readers = Promise.all([consumeChunks(stdout, false), consumeChunks(stderr, true)]).finally(
    () => pipes.close(),
  )
  void Promise.allSettled([readers, child.exited]).then(() => pipes.closeStdin())

  opts.liveChildren?.add(child)
  opts.onSpawn?.(child.pid)

  // Readiness deadline: SIGTERM, wait the grace for the GROUP, SIGKILL
  // what is left, and only then reject. The caller's teardown used to
  // signal the group again a turn after this SIGTERM, and a server whose
  // handler is a one-shot (`process.once('SIGTERM')`, a trap that resets
  // itself) died on the second mid-cleanup. Cleared the moment ready
  // fires so a healthy server is never killed by a stale timer.
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  if (readyRe && opts.timeoutMs !== undefined) {
    const giveUp = async (): Promise<void> => {
      if (readyAt !== undefined) return
      gaveUpAt = Date.now()
      // Listed on the group guard until the SIGKILL: the shell may die on
      // the SIGTERM and let the group go while the server runs out the
      // grace, and a vx killed inside it leaves the server to the guard
      // (kill-tree.ts, item 865).
      const letGo = holdGroups([child])
      try {
        killTree(child, 'SIGTERM')
        // A server that traps TERM and never became ready is not in the
        // persistent registry, so nothing else would ever kill it.
        const left = await untilGroupsGone([child], killGraceMs(TIMEOUT_SIGKILL_GRACE_MS))
        for (const c of left) killTree(c, 'SIGKILL')
        await child.exited
      } finally {
        letGo()
      }
      rejectReady(
        new PersistentReadyError(
          `persistent task not ready within ${opts.timeoutMs}ms — ` +
            `readyWhen pattern never matched; child killed`,
          'timeout',
        ),
      )
    }
    readyTimer = setTimeout(() => {
      readyTimer = afterPendingExits(() => void giveUp())
    }, opts.timeoutMs)
  }

  // If the child exits BEFORE ready fires, that's a failure to start
  // — reject the ready promise so the caller can surface it.
  void child.exited.then(async (code) => {
    opts.liveChildren?.delete(child)
    releaseServerGroup(child)
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    // The exit can land before the readers took the marker it printed on
    // the way out: `echo READY; exit` read as never ready under load. The
    // drain is bounded, as a task's is, for a grandchild holding the pipe.
    if (readyAt === undefined && gaveUpAt === undefined) {
      await Promise.race([
        readers,
        new Promise((resolve) => setTimeout(resolve, POST_EXIT_DRAIN_MS).unref?.()),
      ])
    }
    // A clean exit is ready: a setup step (migrate, seed, a `docker
    // compose up --wait`) has done its work, and what it started, if
    // anything, is torn down with the run (2026-10-22).
    if (code === 0) markReady()
    if (readyAt === undefined && gaveUpAt === undefined) {
      rejectReady(
        new PersistentReadyError(
          `persistent task exited before becoming ready (exit ${code ?? '?'})` +
            (readyRe ? ` — readyWhen pattern never matched` : ''),
          'exited',
          code ?? undefined,
        ),
      )
    }
  })

  // No readyWhen → ready immediately. We still wire the readers above
  // so output streams during the task's lifetime.
  if (!readyRe) markReady()

  return {
    child,
    ready,
    readyMs: () => (readyAt ?? gaveUpAt ?? Date.now()) - start,
  }
}

/** `spawnFailureText`'s `what` for a sandboxed task: its command is the sandbox's wrap of the task's. */
export const SANDBOXED_TASK = 'sandboxed task'

/**
 * What a task's frame says when `Bun.spawn` itself threw. The text goes
 * through `onStderr` AND onto the result: the orchestrator retains no
 * stderr (execute-task's capture), so a reason that only sat on the result
 * reached nobody — a box without `sh` showed "failed (exit 127)" under a
 * bare `$ <command>` and nothing else (2026-09-16). An ENOENT with the
 * working directory in place is the shell, without it the directory; Bun's
 * own text names the rest.
 */
export function spawnFailureText(
  err: unknown,
  cwd: string,
  what = 'task',
  command?: string,
): string {
  if (isExecutableMissing(err)) {
    // Bun names `sh` in the ENOENT a missing directory gives too.
    return existsSync(cwd)
      ? `[vx] vx runs each task with sh -c: failed to spawn 'sh' (working dir: ${cwd}). Install a POSIX sh and re-run.\n`
      : `[vx] failed to spawn ${what}: its working directory ${cwd} does not exist\n`
  }
  return `[vx] failed to spawn ${what}: ${spawnErrorReason(err, what, command)}\n`
}

/** Bun's text for a spawn that threw, and the way out when the limit hit is a known one. */
function spawnErrorReason(err: unknown, what: string, command: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err)
  const hint = isOutOfFds(err)
    ? ` — ${OUT_OF_FDS_HINT}`
    : command !== undefined && (err as NodeJS.ErrnoException | undefined)?.code === 'E2BIG'
      ? ` — ${argTooLongHint(command, what === SANDBOXED_TASK)}`
      : ''
  return `${message}${hint}`
}

/**
 * A task's command, the args after `--` folded in, is ONE argument to
 * `sh -c`, and Linux caps one argument at 128 KiB (MAX_ARG_STRLEN), far
 * below the argv total: a file list forwarded to a linter failed with a
 * bare E2BIG, which reads as "too many files" and names no way out.
 */
function argTooLongHint(command: string, wrapped: boolean): string {
  const kib = Math.ceil(Buffer.byteLength(command) / 1024)
  const what = wrapped ? "with the args after -- and the sandbox's wrap" : 'with the args after --'
  return (
    `the command, ${what}, is ${kib} KiB, and one argument to sh -c may hold at ` +
    `most 128 KiB on Linux: pass a long list through a file the tool reads (xargs, a response file)`
  )
}

export async function runCommand(opts: RunOptions): Promise<RunResult> {
  const start = Date.now()
  const fullCommand = withForwardArgs(opts.command, opts.forwardArgs)

  let proc: ReturnType<typeof Bun.spawn>
  const pipes = new TaskPipes(opts.terminal)
  const restoreModes = opts.terminal === true ? keepTerminalModes() : undefined
  try {
    proc = spawnGuarded((guard) =>
      Bun.spawn(shellArgv((guard === undefined ? '' : guardLine(3)) + execWrap(fullCommand)), {
        ...SH_ARGV0,
        cwd: opts.cwd,
        env: opts.env as Record<string, string>,
        stdio: [...taskStdio(opts.terminal, pipes), ...(guard === undefined ? [] : [guard])],
        // Its own session and process group, so a kill reaches what it
        // forked (kill-tree.ts). A terminal handed over is not this
        // session's controlling one, so no read stops the group.
        detached: true,
      }),
    )
  } catch (err) {
    pipes.close()
    const stderr = spawnFailureText(err, opts.cwd, 'task', fullCommand)
    opts.onStderr?.(stderr)
    return { exitCode: 127, durationMs: Date.now() - start, stdout: '', stderr, spawnFailed: true }
  } finally {
    pipes.spawned()
  }

  opts.liveChildren?.add(proc)
  opts.onSpawn?.(proc.pid)
  const timeout = armTimeout(proc, opts.timeoutMs)
  const ac = new AbortController()
  const [out, err] = pipes.streams(proc)
  const ends = lineEnds(opts.onStdout, opts.onStderr)
  const streams = Promise.all([
    streamToString(out, ends.onStdout, ac.signal, opts.capture?.stdout ?? true),
    streamToString(err, ends.onStderr, ac.signal, opts.capture?.stderr ?? true),
  ]).finally(() => pipes.close())
  // Gate on the child's own exit, not on stream EOF: an orphaned grandchild
  // can keep the pipe open past the child's exit (a timeout SIGTERM leaves the
  // grandchild alive; a NORMAL exit of `server & echo up` does too), so EOF may
  // never arrive. A timeout aborts the readers at once; otherwise drainOrAbort
  // lets a clean exit EOF immediately and only cuts off a stuck reader after a
  // brief grace — without this the run hangs forever.
  await proc.exited
  restoreModes?.()
  await timeout.settle()
  let cut = false
  if (timeout.timedOut()) ac.abort()
  else cut = await drainOrAbort(streams, ac)
  const [stdout, streamed] = await streams
  ends.end()
  const cutLine = ends.own(POST_EXIT_CUT_LINE)
  if (cut) opts.onStderr?.(cutLine)
  const stderr = cut ? streamed + cutLine : streamed
  opts.liveChildren?.delete(proc)
  releaseGroup(proc)
  const exited = proc.exitCode ?? (proc.signalCode ? signalExitCode(proc.signalCode) : 1)
  // A timeout is a failure, whatever the child said: one that traps the
  // TERM and exits 0 reported success to every executor built on this.
  const exitCode = exited === 0 && timeout.timedOut() ? signalExitCode('SIGTERM') : exited
  return {
    exitCode,
    durationMs: Date.now() - start,
    stdout,
    stderr,
    ...(proc.signalCode != null ? { signal: proc.signalCode } : {}),
    ...(timeout.timedOut() ? { timedOut: true } : {}),
    ...(cut ? { leftRunning: true } : {}),
    ...resourceUsageToCpuRss(proc.resourceUsage(), rssFloorFor),
  }
}

/**
 * This process's own RSS high-water mark, in bytes: the floor under which
 * a child's `ru_maxrss` says nothing about the child. Linux folds the
 * forking parent's high-water mark into the child's figure at exec (a
 * forked child starts with its parent's pages; `exec_mmap` keeps the old
 * mm's peak), so a task lighter than vx itself reads vx's footprint —
 * `true` read 44 MB through vx while its shell's `VmHWM` was 1.9 MB, and
 * 300 MB allocated in the parent made `true` read 328 MB (2026-09-12).
 * Read after the child exits so it covers the whole task's span (the mark
 * is monotonic). Linux reads `VmHWM`; elsewhere the current RSS is the
 * bound in hand.
 */
export function ownRssHighWater(): number {
  // `VmHWM`, not getrusage's own peak: that one also holds the peak of the
  // image this process exec'd from, which under vfork is the PARENT's
  // memory — vx spawned from a 300 MB test runner (or node) read a floor
  // of 300 MB, and a task holding 150 MB reported no peak (I-40's
  // regression, tests/own-rss-high-water.test.ts).
  if (process.platform === 'linux') {
    try {
      const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8'))
      if (m !== null) return (highWaterSeen = Number(m[1]) * 1024)
    } catch {
      // /proc unreadable: fall through to the current RSS.
    }
  }
  return process.memoryUsage.rss()
}

/** The last `VmHWM` read, in bytes; 0 until one is. */
let highWaterSeen = 0

/**
 * The floor for a child's `peak`, read only when the last `VmHWM` cannot
 * decide it: the mark never falls, so a peak within the slack of an older
 * reading is within the slack of the current one, and goes unreported
 * either way. A light task reads vx's own mark as its peak, so after the
 * first such task the rest skip the read, which cost ~35 µs of the
 * scheduler's thread per task (500 cold tasks, 2026-10-07). A current-RSS
 * fallback is not monotonic and is never reused.
 */
function rssFloorFor(peak: number): number {
  return peak <= highWaterSeen + RSS_FLOOR_SLACK_BYTES ? highWaterSeen : ownRssHighWater()
}

/**
 * What a task's captured output keeps: the first `CAPTURE_HEAD_CHARS` and
 * the last `CAPTURE_TAIL_CHARS` characters, the dropped middle counted and
 * named where it was. The live stream is never bounded — every byte still
 * reaches the terminal as the task writes it — only the copy vx retains
 * for the cache entry and its replay. Unbounded, a task printing 200 MB
 * cost vx 620 MB of RSS on the miss AND on every hit, and its stdout sat
 * whole in `cache.db` (measured 2026-09-16); a realistic chatty suite is
 * 5–20 MB, so the bound is above what a replay is worth reading anyway.
 */
export const CAPTURE_HEAD_CHARS = 8 * 1024 * 1024
export const CAPTURE_TAIL_CHARS = 8 * 1024 * 1024

/** The line that stands where the dropped middle was. */
export function droppedOutputLine(
  dropped: number,
  headChars = CAPTURE_HEAD_CHARS,
  tailChars = CAPTURE_TAIL_CHARS,
): string {
  return (
    // In vx's own units: a fixed MiB tier printed a few KiB dropped as `0.0 MiB`.
    `\n[vx] ${formatBytes(dropped)} of output not kept — vx keeps the first ${formatBytes(headChars)} ` +
    `and the last ${formatBytes(tailChars)} of a task's output\n`
  )
}

/**
 * A captured `text` with `secrets` masked. A value the dropped middle cut
 * left a piece at the head's end and one at the tail's start, which the
 * whole-value mask missed, and the cache entry stored and replayed both.
 */
export function maskCaptured(text: string, secrets: SecretMask): string {
  const at = text.indexOf('\n[vx] ', CAPTURE_HEAD_CHARS - 1)
  const end = at === -1 ? -1 : text.indexOf('\n', at + 1) + 1
  if (at === -1 || at > CAPTURE_HEAD_CHARS || !DROPPED_LINE.test(text.slice(at, end))) {
    return secrets.mask(text)
  }
  const [head, tail] = secrets.maskCut(text.slice(0, at), text.slice(end))
  return head + text.slice(at, end) + tail
}

const DROPPED_LINE = /^\n\[vx\] [\d.]+ [KMGTP]?B of output not kept — /

/** Whether `chunk` is the line a `BoundedCapture` puts where its dropped middle was. */
export function isDroppedOutputChunk(chunk: CapturedChunk): boolean {
  return !chunk.err && DROPPED_LINE.test(chunk.text)
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** One piece of a task's output and the stream it came on. */
export interface CapturedChunk {
  text: string
  /** True when the task wrote it to stderr. */
  err: boolean
}

/**
 * A head-and-tail accumulator: the head fills once, the tail is a ring
 * of chunks trimmed from the front, so memory is bounded by the two
 * limits plus one chunk whatever the task prints. Each chunk keeps its
 * stream, so one capture can hold both in the order they arrived.
 */
export class BoundedCapture {
  private readonly head: CapturedChunk[] = []
  private headLen = 0
  private readonly tail: CapturedChunk[] = []
  private tailLen = 0
  private dropped = 0

  constructor(
    private readonly headChars = CAPTURE_HEAD_CHARS,
    private readonly tailChars = CAPTURE_TAIL_CHARS,
  ) {}

  push(text: string, err = false): void {
    // Once the tail has begun the head is closed, even a unit short of its
    // bound (the surrogate case below): a later short chunk fit there and
    // was retained ahead of the chunk before it.
    if (this.tailLen === 0 && this.headLen < this.headChars) {
      let room = this.headChars - this.headLen
      if (text.length <= room) {
        this.head.push({ text, err })
        this.headLen += text.length
        return
      }
      // Never between a surrogate pair's halves: the bounds count UTF-16
      // units, and a halved character read U+FFFD in the replay.
      if (isHighSurrogate(text.charCodeAt(room - 1))) room--
      this.head.push({ text: text.slice(0, room), err })
      this.headLen += room
      text = text.slice(room)
    }
    this.tail.push({ text, err })
    this.tailLen += text.length
    while (this.tailLen > this.tailChars) {
      const first = this.tail[0]!
      const excess = this.tailLen - this.tailChars
      if (first.text.length <= excess) {
        this.tail.shift()
        this.tailLen -= first.text.length
        this.dropped += first.text.length
      } else {
        const cut = isHighSurrogate(first.text.charCodeAt(excess - 1)) ? excess + 1 : excess
        this.tail[0] = { text: first.text.slice(cut), err: first.err }
        this.tailLen -= cut
        this.dropped += cut
      }
    }
  }

  /**
   * The same output under tighter bounds. What this capture already
   * dropped is counted in the new one's dropped line: pushed through
   * `chunks()`, the old line fell into the new middle with its count.
   * `through` maps each side's chunks before the new cut (the store's
   * mask), so the cut cannot split a value first.
   */
  rebound(
    headChars: number,
    tailChars: number,
    through: (chunks: CapturedChunk[]) => CapturedChunk[] = (c) => c,
  ): BoundedCapture {
    const to = new BoundedCapture(headChars, tailChars)
    for (const c of through(this.head)) to.push(c.text, c.err)
    for (const c of through(this.tail)) to.push(c.text, c.err)
    to.dropped += this.dropped
    return to
  }

  /** The kept chunks in arrival order, the dropped middle named on stdout. */
  chunks(): CapturedChunk[] {
    return this.dropped === 0
      ? [...this.head, ...this.tail]
      : [
          ...this.head,
          {
            text: droppedOutputLine(this.dropped, this.headChars, this.tailChars),
            err: false,
          },
          ...this.tail,
        ]
  }

  text(): string {
    return this.chunks()
      .map((c) => c.text)
      .join('')
  }
}

/**
 * Drain a `Bun.spawn` stdout/stderr stream while invoking the live
 * callback per UTF-8 chunk. Returns the accumulated string, or `''` when
 * `retain` is false — the stream is still fully drained and every chunk
 * still reaches `onChunk`; only the retained copy is dropped, so a caller
 * that will not read it does not pay its byte size in heap.
 */
export async function streamToString(
  stream: ReadableStream<Uint8Array> | number | undefined,
  onChunk?: (s: string) => void,
  signal?: AbortSignal,
  retain = true,
): Promise<string> {
  // Bun.spawn types stdout/stderr as `ReadableStream | number | undefined`;
  // a stream the child inherited (`terminal`) is not one, and holds nothing.
  if (!stream || typeof stream === 'number') return ''
  const full = new BoundedCapture()
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  // On abort, cancel the read so a pending `reader.read()` resolves
  // `done` and we return whatever we captured. Needed for the timeout
  // path: SIGTERMing `sh` doesn't close the pipe if an orphaned
  // grandchild still holds the write end, so EOF never arrives — the
  // abort breaks us out instead of hanging the run.
  const onAbort = (): void => void reader.cancel().catch(() => {})
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (retain) full.push(chunk)
      onChunk?.(chunk)
    }
    const tail = decoder.decode()
    if (tail.length > 0) {
      if (retain) full.push(tail)
      onChunk?.(tail)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return full.text()
}

/**
 * How far above the parent's own mark a child's `ru_maxrss` must read to
 * count as the child's. A light child inherits the parent's footprint at
 * exec, so its reading sits ON the floor by construction, and the kernel's
 * per-thread RSS counters lag by up to 64 pages between syncs — a `true`
 * spawned from a 300 MB parent read 376 MB against a floor a few pages
 * lower on one CI run in twelve (2026-09-16). Four MiB is above any
 * accounting jitter and below what any reservation resolves (64 MB steps).
 */
export const RSS_FLOOR_SLACK_BYTES = 4 * 1024 * 1024

const MIN_PLAUSIBLE_PEAK_BYTES = 1024 * 1024

/**
 * A child's `maxRSS` in BYTES, whatever unit the runtime reported it in.
 *
 * Bun >= 1.4 — vx's declared floor — normalizes the kernel's `ru_maxrss`
 * (kilobytes on Linux, bytes on macOS) before handing it over, and this file
 * used to state that as "BYTES on every platform". It is not true of every
 * Bun: 1.3.11 passes the raw kilobytes through, so every peak read 1024×
 * SMALL, fell under the parent floor and recorded nothing. The opposite
 * mistake is in this file's own history — an unconditional ×1024 on Linux
 * made a 64 MB suite read as 64 GB and, once reservations were learned from
 * that history, ran every task alone (2026-09-12). Both directions come from
 * asserting a platform unit instead of deciding it from the number in hand.
 *
 * The number decides it. No process peaks under a megabyte — a bare `true`
 * costs a couple — so a reading below that is not bytes, it is the kernel's
 * kilobytes, and multiplying is right by the same margin that makes the test
 * safe. A real byte figure is never near the threshold, and neither is a real
 * kilobyte one: the two live 1024× apart.
 *
 * Calibrating against this process's OWN `process.resourceUsage()` was the
 * first attempt and it was wrong: that is the node-compatible API, which
 * reports kilobytes even where `Subprocess.resourceUsage()` reports bytes, so
 * the ratio read 1024 on a runtime already handing over bytes and doubled the
 * old 64 GB defect. It passed here, where both APIs use kilobytes, and turned
 * CI red on both platforms (2026-09-20). Compare like with like, or do not
 * compare at all.
 */
export function peakRssBytes(maxRSS: number): number {
  return maxRSS > 0 && maxRSS < MIN_PLAUSIBLE_PEAK_BYTES ? maxRSS * 1024 : maxRSS
}

/**
 * Pull CPU + RSS out of Bun's resourceUsage() shape into our schema's
 * shape (ms + bytes). Returns an empty object when usage isn't available
 * (e.g., the platform didn't expose rusage), so the orchestrator records
 * NULLs in the runs table for those tasks.
 */
export function resourceUsageToCpuRss(
  usage: ReturnType<ReturnType<typeof Bun.spawn>['resourceUsage']>,
  /** The parent's own high-water mark (`ownRssHighWater`), or a function of the peak that answers it; a peak at or under it is inherited, not the child's, and is not reported. */
  floorBytes: number | ((peak: number) => number) = 0,
): { cpuMs?: number; peakRssBytes?: number } {
  if (!usage) return {}
  // cpuTime.total is microseconds as a bigint → ms.
  const cpuMs = Number(usage.cpuTime.total) / 1000
  // `maxRSS` in whatever unit this runtime reports, in bytes by the rule
  // above. `tests/runner.test.ts` allocates a known number of bytes and
  // reads the peak back within a bounded factor of it, which is the
  // end-to-end check on both the unit and the floor.
  // A reading at or within the slack of the parent's own mark is the
  // parent's (see `ownRssHighWater`, `RSS_FLOOR_SLACK_BYTES`): the child's
  // peak is unknown, bounded by it.
  const peak = peakRssBytes(usage.maxRSS)
  const floor = typeof floorBytes === 'number' ? floorBytes : floorBytes(peak)
  return peak > floor + RSS_FLOOR_SLACK_BYTES ? { cpuMs, peakRssBytes: peak } : { cpuMs }
}
