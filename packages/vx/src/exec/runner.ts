// Child-process invocation and resource accounting: Bun.spawn gives
// `resourceUsage()` (CPU, max RSS) after exit, surfaced on RunResult for the
// `runs` table.

import { existsSync, readFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import {
  formatBytes,
  shellArgv,
  isExecutableMissing,
  isOutOfFds,
  killGraceMs,
  OUT_OF_FDS_HINT,
  POST_EXIT_DRAIN_MS,
  testTimerMs,
  helperEnv,
  RawUtf8Decoder,
  type SecretMask,
} from '../util/index.js'
import {
  type Child,
  closeSignalChannel,
  groupAlive,
  holdGroups,
  killTree,
  releaseGroup,
  releaseServerGroup,
  signalThrough,
  guardLine,
  spawnGuarded,
  runTime,
  untilGroupsGone,
} from './kill-tree.js'
import { type TreeUsage, watchTree } from './proc-sample.js'
import { TaskPipes } from './pipes.js'
import { spawnOff } from './spawn-off.js'
import { runOnSpare, spareScript, takeSpare } from './warm-shell.js'

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
  /** The timeout's SIGKILL past the grace took a process of the task's
   *  group: the child, or one it left after dying of the SIGTERM. */
  killedAfterGrace?: true
  /** Total user+system CPU time for the child, in milliseconds. */
  cpuMs?: number
  /** Peak resident set size for the child, in bytes. */
  peakRssBytes?: number
  /** `Bun.spawn` threw: no shell ran, so its 127 is vx's and says nothing
   *  about the command. */
  spawnFailed?: true
  /** The shell exited while a process it started still ran: one holding
   *  stdout/stderr past the drain bound (`POST_EXIT_CUT_LINE`), or one left
   *  in the task's process group. It may still write the task's outputs,
   *  so the result is not saved. */
  leftRunning?: true
}

/**
 * Which streams `runCommand` retains into `RunResult.stdout` / `.stderr`. Both
 * default true: those fields hold what the child wrote. A caller that will not
 * read one opts out here; live callbacks still fire, only the retained copy
 * (its full size in heap) is dropped.
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
   * Upper bound (ms) on run time: then the child is SIGTERMed and flagged
   * `timedOut`. Undefined: no limit.
   */
  timeoutMs?: number
  /**
   * Run-scoped registry of live subprocesses, so the signal handler can SIGTERM
   * all still alive.
   */
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  /** The run's stop (`ExecuteRequest.signal`): one that lands before the child is in `liveChildren` stops it here. */
  signal?: AbortSignal
  /** Told the child's pid once it is spawned (telemetry samples its tree). */
  onSpawn?: (pid: number) => void
  /**
   * Hand the child vx's own stdio (`exec.interactive` on a TTY): the callbacks
   * hear nothing and the streams are empty.
   */
  terminal?: boolean
}

type Fd = 'inherit' | 'ignore' | 'pipe' | number

/** A child's descriptors 0–2: vx's own for a task that holds the terminal. */
function taskStdio(terminal: boolean | undefined, pipes: TaskPipes): [Fd, Fd, Fd] {
  return terminal === true ? ['inherit', 'inherit', 'inherit'] : [pipes.stdin, ...pipes.stdio]
}

/**
 * Save the terminal's modes before a task that holds it, and return their
 * restore: a task killed in raw mode left the terminal with no echo or Ctrl-C,
 * and Bun restores modes only when vx's stdout is the terminal. `detached` like
 * the task, or a background vx is stopped by SIGTTOU.
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
 * Restore the terminal now for every task still holding it: vx is exiting
 * without waiting for them (a second signal).
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
 * One pass over `command` as sh reads it. `comment`: where a comment still open
 * at the end starts, or -1 (`#` opens one only unquoted at a word start; a
 * newline closes it). `body`: per line, heredoc body or terminator. One scan,
 * as each needs the other: a `<<X` in a comment or quotes opens no heredoc, and
 * a quote in a body opens nothing.
 */
function shellShape(command: string): {
  comment: number
  body: boolean[]
  subshell: boolean
  quoted: boolean
} {
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
      // The delimiter is a whole word, quotes removed. One opening with a digit
      // is left alone, for `$((x<<2))`.
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
  return { comment, body, subshell, quoted: quote !== '' }
}

// One redirection at the end of a command: an fd, an operator, and a
// target word (quoted parts and `<(…)` / `>(…)` included).
const TRAILING_REDIRECT =
  /(?:^|[\s)])(?:&>>?|\d*(?:<<<|>>|>&|<&|<>|>\||>|<))[ \t]*(?:[<>]\([^()]*\)|(?:[^\s;&|()<>'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")+)$/

/**
 * Where trailing redirections start after a compound command's closer (`(cmd)
 * 2>&1`, `done < f`), or -1. Not inside quotes or a comment.
 */
function redirectsAfterCloser(command: string): number {
  let head = command
  for (;;) {
    const m = TRAILING_REDIRECT.exec(head)
    if (m === null) break
    const start = m.index + (/^[\s)]/.test(m[0]) ? 1 : 0)
    const rest = head.slice(0, start)
    const shape = shellShape(rest)
    if (shape.quoted || shape.comment >= 0 || /(?:^|[^\\])(?:\\\\)*\\$/.test(rest)) break
    head = rest.trimEnd()
  }
  if (head.length === command.length) return -1
  return shellShape(head).subshell || COMPOUND_CLOSER.test(head) ? head.length : -1
}

const COMPOUND_CLOSER = /(?:^|[^\\])(?:\\\\)*[;&\n][ \t]*(fi|done|esac|\})$/

/**
 * The task's command with the args after `--` appended, shell-quoted, before
 * any trailing comment (after it they vanished silently). Trailing blanks go
 * first.
 */
export function withForwardArgs(command: string, args: readonly string[] | undefined): string {
  if (!args || args.length === 0) return command
  // A command ending in a heredoc body: args go on the last command line (`cat
  // <<X FWD`), not after the terminator, where they closed nothing.
  const trimmed = command.trimEnd()
  const lines = trimmed.split('\n')
  const shape = shellShape(trimmed)
  if (shape.body[lines.length - 1] === true) {
    const last = shape.body.lastIndexOf(false)
    const tail = lines.slice(last + 1).join('\n')
    return `${withForwardArgs(lines.slice(0, last + 1).join('\n'), args)}\n${tail}`
  }
  const quoted = args.map(shellQuote).join(' ')
  // Of the trimmed command: a template literal's final newline closed its
  // comment too, and the args fell into it.
  let comment = shape.comment
  if (comment < 0) {
    // A command ending in a newline ran the args as a command of their own.
    // Kept when an odd run of backslashes ends it: that escapes what follows.
    const escaped = (/\\+$/.exec(trimmed)?.[0].length ?? 0) % 2 === 1
    // Likewise a trailing `;`, `&` or `;;`: the args go before it. An escaped
    // one (`-exec … \;`) is a word.
    const sep = /(?:^|[^;&|<>\\])(?:\\\\)*(;;|[;&])$/.exec(trimmed)?.[1]
    // After a compound command's closer the args were a syntax error (`fi
    // --fix`): they go to the last command inside. A closer counts only where a
    // command starts.
    const closer = shape.subshell ? ')' : COMPOUND_CLOSER.exec(trimmed)?.[1]
    const end = sep ?? closer
    // Redirections after the closer (`(cmd) 2>&1`, `done < f`) hid it: the
    // args go inside it and the redirections stay after.
    const at = end === undefined ? redirectsAfterCloser(trimmed) : -1
    if (at >= 0) return `${withForwardArgs(trimmed.slice(0, at), args)}${trimmed.slice(at)}`
    if (end !== undefined) {
      const head = trimmed.slice(0, -end.length).trimEnd()
      return `${withForwardArgs(head, args)}${trimmed.slice(head.length)}`
    }
    // Only the one character the backslash escapes: blank lines after a
    // continuation put the args on a command line of their own.
    return `${escaped ? command.slice(0, trimmed.length + 1) : trimmed} ${quoted}`
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

// Any shell control or expansion character means `sh` has real work to do and
// must stay resident.
const SHELL_CONTROL = /[&|;<>(){}$`\n\\!*?~]/

// Builtins run inside sh (`exec <builtin>` fails) and spawn nothing, so nothing
// to gain by exec-wrapping.
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
 * Prepend `exec ` to a command that is one external program (no control
 * characters, no builtin, no leading assignment): the program replaces `sh`, so
 * `resourceUsage` measures it, signals reach it directly, and there is one
 * process fewer.
 */
export function execWrap(command: string): string {
  const first = execWord(command)
  return first === undefined ? command : `exec ${command}`
}

/**
 * The one program a plain `word args…` runs: the word `execWrap` execs and the
 * shell names on exit 127. Undefined for a pipeline, builtin or assignment,
 * where the 127 could be any segment's.
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
 * POSIX shells report signal death as 128 + n (SIGTERM 143, SIGKILL 137). Bun
 * gives the name, or the number for an unnamed signal; `os.constants` maps
 * names per platform. Unknown names fall back to 130.
 */
export function signalExitCode(signal: string | number): number {
  if (typeof signal === 'number') return 128 + signal
  const num = (osConstants.signals as Partial<Record<string, number>>)[signal]
  return num === undefined ? 130 : 128 + num
}

/**
 * The signal a run's stop sends a task, from its abort reason; a hang-up
 * forwards SIGTERM (to many servers SIGHUP means reload).
 */
export function stopSignal(reason: unknown): 'SIGINT' | 'SIGTERM' {
  return reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM'
}

/**
 * The signal an exit above 128 stands for, by platform numbering; undefined for
 * a plain exit. The shell's convention, not proof: a command may exit 137
 * itself.
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
 * Run `fn` one loop turn later, after pending child exits are read: a deadline
 * due in the same turn as an exit fires before Bun reaps it, so a task that
 * exited 0 in time was failed as timed out, and a server that died read as a
 * readiness timeout.
 */
function afterPendingExits(fn: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(fn, 0)
}

/**
 * Run `fn` after `ms` of run time. Time vx spent stopped (Ctrl-Z) is not run
 * time: its tasks were stopped too.
 */
function afterRunTime(ms: number, fn: () => void): { clear: () => void } {
  // Re-arm for the run time left, or a long Ctrl-Z lifted the timeout.
  const due = runTime() + ms
  let timer: ReturnType<typeof setTimeout>
  const arm = (delay: number): void => {
    timer = setTimeout(() => {
      const left = due - runTime()
      if (left > 1) arm(left)
      else timer = afterPendingExits(fn)
    }, delay)
  }
  arm(ms)
  return { clear: () => clearTimeout(timer) }
}

/**
 * Arm a SIGTERM timeout on a child. `timedOut()` says whether it fired (a real
 * failure, not a Ctrl-C abort); `settle()`, awaited after exit, cancels the
 * timers and, if it fired, waits out the grace for the child's group and
 * SIGKILLs what is left (`sigkilled()` says if anyone was). The shell dying is
 * not the tree dying: a backgrounded process ignoring SIGTERM lived on under
 * init (nx#11782). A no-op without `timeoutMs`.
 */
export function armTimeout(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number | undefined,
): { timedOut: () => boolean; sigkilled: () => boolean; settle: () => Promise<void> } {
  if (timeoutMs === undefined)
    return { timedOut: () => false, sigkilled: () => false, settle: async () => {} }
  let firedAt: number | undefined
  let sigkilled = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const graceMs = killGraceMs(TIMEOUT_SIGKILL_GRACE_MS)
  const timer = afterRunTime(timeoutMs, fire)
  function fire(): void {
    firedAt = performance.now()
    killTree(proc, 'SIGTERM')
    // Escalate to SIGKILL after a grace: a child that ignores SIGTERM would
    // otherwise hang the run forever (there is no run-level timeout). Unref'd.
    killTimer = setTimeout(() => {
      sigkilled = true
      killTree(proc, 'SIGKILL')
    }, graceMs)
    killTimer.unref?.()
  }
  return {
    timedOut: () => firedAt !== undefined,
    sigkilled: () => sigkilled,
    settle: async () => {
      timer.clear()
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (firedAt === undefined) return
      const left = await untilGroupsGone([proc], Math.max(0, firedAt + graceMs - performance.now()))
      for (const child of left) killTree(child, 'SIGKILL')
      if (left.length > 0) sigkilled = true
    },
  }
}

/**
 * The line a task's frame gets when the drain bound cut its pipes: a
 * backgrounded child's late output otherwise vanished silently (nx#35302). The
 * bound stays, since it keeps a leftover server from hanging the run.
 */
export const POST_EXIT_CUT_LINE =
  `[vx] output after the task's shell exited was cut: a process it left running ` +
  `still held its stdout/stderr ${POST_EXIT_DRAIN_MS} ms later\n`

/**
 * How long one stream waits on the other's open line. dash writes `sh: 1:
 * cannot open /dev/tty: …` in pieces; a line open longer is a prompt or
 * progress line, and the other stream goes live.
 */
export const OPEN_LINE_WAIT_MS = 50
/** And how much of it waits: the hold never costs more than this per task. */
export const OPEN_LINE_HOLD_CHARS = 64 * 1024

/**
 * A task's two output callbacks merged a line at a time. Two pipes read as they
 * arrive let a stdout write land inside dash's stderr line written in pieces.
 * So a chunk waits while the other stream's line is open; its text after the
 * last newline goes after the held output. Past `OPEN_LINE_WAIT_MS`,
 * `OPEN_LINE_HOLD_CHARS` or `end` it goes as written, unbroken: an inserted
 * newline became the stream's own text on replay. `own` breaks the line before
 * vx's text only. A lone stream is never held. An absent callback stays absent.
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
  // A test lengthens it to drive the hold itself on a loaded runner, where a
  // `sleep` between two writes outlasted 50 ms (macOS CI).
  const waitMs = testTimerMs('OPEN_LINE_WAIT', OPEN_LINE_WAIT_MS)
  const sinks = [onStdout, onStderr]
  /** The stream whose line is open (0 stdout, 1 stderr). */
  let open: 0 | 1 | undefined
  /** What the other stream wrote while that line was open: one side at most. */
  const held = ['', '']
  /** When what waits began to: the bound counts from there. */
  let heldAt = 0
  // One timer, re-armed only when it fires early: one per line cost 26 ms of
  // CPU on 20,000 short lines.
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
 * After the child exits, wait for the readers' EOF, bounded: an orphaned
 * grandchild holding the pipe would hang the run. On expiry abort the readers
 * (returning what they captured) and resolve true, so the caller adds
 * `POST_EXIT_CUT_LINE`. Unref'd, never cleared: a late resolve changes nothing.
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
 * Upper bound on the text a `readyWhen` regex is tested against; bites only on
 * a stream with no line breaks.
 */
const READY_MATCH_WINDOW_CHARS = 64 * 1024

/**
 * Terminal escapes a `readyWhen` pattern is matched without (CSI, OSC, charset
 * picks, two-byte forms): Vite under `FORCE_COLOR` prints
 * `\x1b[1mLocal\x1b[22m:`, which `Local:` never matched. The streamed bytes
 * keep them.
 */
const TERMINAL_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex -- ESC is the point
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]+[0-~]|[@-Z\\-_])/g

/**
 * Why a persistent task never became ready, read instead of a fabricated exit.
 * `exitCode` is the child's when it exited first.
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
   * Resolves when the task is ready: at spawn with no `readyWhen`, else on the
   * first line matching it. Rejects if the spawn fails.
   */
  ready: Promise<void>
  /** ms from spawn to ready, to the readiness timeout giving up, or to now. */
  readyMs: () => number
  /** Whether the readiness timeout fired: `ready` rejects only after the kill grace. */
  gaveUp: () => boolean
}

// `capture` is `runCommand`'s: a persistent task returns at ready with no
// retained string; its output reaches the caller only through the callbacks.
export interface PersistentOptions extends Omit<RunOptions, 'forwardArgs' | 'capture'> {
  /**
   * String regex. The first stdout/stderr line that matches signals
   * "ready". Undefined → ready immediately on spawn.
   */
  readyWhen?: string
  /**
   * Bound the readiness wait: if `readyWhen` has not matched in time, the child
   * is SIGTERMed and `ready` rejects.
   */
  timeoutMs?: number
  /**
   * Called once, at ready: after `onStdout` / `onStderr` had the text up to
   * the end of the ready line, before anything after it. What follows is
   * the since-ready stream; a chunk holding both is split there.
   */
  onReady?: () => void
  /**
   * Spawn with fd 3 as its signal channel (`signalThrough`): a Linux sandboxed
   * command, whose group signal would kill bwrap instead.
   */
  signalChannel?: boolean
}

/**
 * Spawn a long-running task, returning once it is ready, not at exit. The
 * caller owns `child` and must SIGTERM it; output keeps streaming to the
 * callbacks.
 */
export function runPersistent(opts: PersistentOptions): PersistentSpawn {
  const start = performance.now()
  let readyAt: number | undefined
  // When the readiness wait gave up: the wait's length, not the kill grace
  // a TERM-trapping server runs out after it.
  let gaveUpAt: number | undefined
  // The shell exited non-zero before a match: a marker read after it, from
  // a child it left running, cannot make an exited server ready.
  let failedExit = false

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
          // A pipe vx holds and never writes, so stdin ends only with vx: a dev
          // server exiting on stdin EOF (esbuild --watch, turborepo#8915)
          // exited 0 under 'ignore'. Not the terminal unless asked: several
          // servers would steal keystrokes. The one-shot spawn keeps 'ignore',
          // so a stdin-reading task cannot hang CI.
          stdio: [
            ...taskStdio(opts.terminal, pipes),
            ...(signalFd ? ['pipe' as const] : []),
            ...(guard === undefined ? [] : [guard]),
          ],
          // Its own session and process group, so a kill reaches what it forked
          // (kill-tree.ts). A handed-over terminal is not this session's
          // controlling one, so no read stops the group.
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
        : spawnErrorReason(
            err,
            opts.signalChannel === true ? SANDBOXED_TASK : 'task',
            opts.command,
            opts.env,
          )
    return {
      child: undefined,
      ready: Promise.reject(
        new PersistentReadyError(`failed to spawn persistent task: ${message}`, 'spawn'),
      ),
      readyMs: () => Math.round(performance.now() - start),
      gaveUp: () => false,
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
    if (readyAt === undefined && gaveUpAt === undefined && !failedExit) {
      readyAt = performance.now()
      readyTimer?.clear()
      resolveReady()
      opts.onReady?.()
    }
  }

  // Each stream keeps a pending fragment so a match is not missed across
  // chunks. The pattern is tested against each line alone, without its break or
  // escapes, so `^` and `$` anchor as a user reads them; `\r` ends a line
  // (progress frames). The trailing partial line is tested too, for
  // prompt-style markers.
  const readyLine = (re: RegExp, line: string): boolean =>
    re.test(line.includes('\x1b') ? line.replace(TERMINAL_ESCAPE_RE, '') : line)
  const consumeChunks = async (
    stream: ReadableStream<Uint8Array> | number | undefined,
    isStderr: boolean,
  ): Promise<void> => {
    if (!stream || typeof stream === 'number') return
    let fragment = ''
    // Chunks are forwarded, never retained: the logger keeps its own bounded
    // tail from these callbacks.
    const forward = (text: string): void => {
      if (text.length === 0) return
      if (isStderr) opts.onStderr?.(text)
      else opts.onStdout?.(text)
    }
    // Where in `chunk` the ready line ends (past its break), or -1.
    const readyEnd = (re: RegExp, chunk: string): number => {
      const base = fragment.length
      fragment += chunk
      let start = 0
      for (let i = base; i < fragment.length; i++) {
        const c = fragment.charCodeAt(i)
        if (c !== 10 && c !== 13) continue
        if (readyLine(re, fragment.slice(start, i))) {
          fragment = ''
          return i + 1 - base + (c === 13 && chunk.charCodeAt(i + 1 - base) === 10 ? 1 : 0)
        }
        start = i + 1
      }
      fragment = fragment.slice(start)
      if (readyLine(re, fragment)) {
        fragment = ''
        return chunk.length
      }
      // A stream with no line breaks would grow the fragment without bound (464
      // MiB in 6 s, quadratic CPU): keep only the most recent window.
      if (fragment.length > READY_MATCH_WINDOW_CHARS) {
        fragment = fragment.slice(fragment.length - READY_MATCH_WINDOW_CHARS)
      }
      return -1
    }
    const handleChunk = (chunk: string): void => {
      if (chunk.length === 0) return
      if (!readyRe || readyAt !== undefined) return forward(chunk)
      const end = readyEnd(readyRe, chunk)
      if (end < 0) return forward(chunk)
      // Split where the ready line ends: lines after it in the same write would
      // read as pre-ready, in a frame a ready server never prints.
      forward(chunk.slice(0, end))
      markReady()
      forward(chunk.slice(end))
    }
    const reader = stream.getReader()
    const decoder = new RawUtf8Decoder()
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

  // Readiness deadline: SIGTERM, wait the grace for the group, SIGKILL what is
  // left, then reject. Signalling again later killed servers whose handler is
  // one-shot mid-cleanup. Cleared on ready.
  let readyTimer: { clear: () => void } | undefined
  if (readyRe && opts.timeoutMs !== undefined) {
    const limit = opts.timeoutMs
    const giveUp = async (): Promise<void> => {
      if (readyAt !== undefined) return
      gaveUpAt = performance.now()
      // On the group guard until the SIGKILL: the shell may die and let the
      // group go while the server runs out the grace.
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
          `no line matched readyWhen /${readyRe.source}/ within ${asWritten(limit)}; killed`,
          'timeout',
        ),
      )
    }
    readyTimer = afterRunTime(opts.timeoutMs, () => void giveUp())
  }

  // If the child exits BEFORE ready fires, that's a failure to start
  // — reject the ready promise so the caller can surface it.
  void child.exited.then(async (code) => {
    opts.liveChildren?.delete(child)
    releaseServerGroup(child)
    readyTimer?.clear()
    if (code !== 0) failedExit = true
    // What the shell wrote reaches the frame before the failure line. The
    // drain is bounded, as a task's is, for a grandchild holding the pipe.
    if (readyAt === undefined && gaveUpAt === undefined) {
      await Promise.race([
        readers,
        new Promise((resolve) => setTimeout(resolve, POST_EXIT_DRAIN_MS).unref?.()),
      ])
    }
    // A clean exit is ready: a setup step has done its work, and what it
    // started is torn down with the run.
    if (code === 0) markReady()
    if (readyAt === undefined && gaveUpAt === undefined) {
      rejectReady(
        new PersistentReadyError(
          `exited (exit ${code ?? '?'})` +
            (readyRe ? ` before a line matched readyWhen /${readyRe.source}/` : ''),
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
    readyMs: () => Math.round((readyAt ?? gaveUpAt ?? performance.now()) - start),
    gaveUp: () => gaveUpAt !== undefined,
  }
}

/** `spawnFailureText`'s `what` for a sandboxed task: its command is the sandbox's wrap of the task's. */
export const SANDBOXED_TASK = 'sandboxed task'

/**
 * What a task's frame says when `Bun.spawn` threw. Through `onStderr` and the
 * result: the orchestrator retains no stderr, so a box without `sh` showed only
 * "failed (exit 127)". ENOENT with the cwd present is the shell, else the
 * directory.
 */
export function spawnFailureText(
  err: unknown,
  cwd: string,
  what = 'task',
  command?: string,
  /** The spawn's environment: an `E2BIG` it caused names it, not the command. */
  env?: NodeJS.ProcessEnv,
): string {
  if (isExecutableMissing(err)) {
    // Bun names `sh` in the ENOENT a missing directory gives too.
    return existsSync(cwd)
      ? `[vx] vx runs each task with sh -c: failed to spawn 'sh' (working dir: ${cwd}). Install a POSIX sh and re-run.\n`
      : `[vx] failed to spawn ${what}: its working directory ${cwd} does not exist\n`
  }
  return `[vx] failed to spawn ${what}: ${spawnErrorReason(err, what, command, env)}\n`
}

/** Bun's text for a spawn that threw, and the way out when the limit hit is a known one. */
function spawnErrorReason(
  err: unknown,
  what: string,
  command: string | undefined,
  env?: NodeJS.ProcessEnv,
): string {
  const message = err instanceof Error ? err.message : String(err)
  const hint = isOutOfFds(err)
    ? ` — ${OUT_OF_FDS_HINT}`
    : command !== undefined && (err as NodeJS.ErrnoException | undefined)?.code === 'E2BIG'
      ? ` — ${argTooLongHint(Buffer.byteLength(command), what === SANDBOXED_TASK, env)}`
      : ''
  return `${message}${hint}`
}

const MAX_ARG_STRLEN = 128 * 1024

/**
 * The command is one argument to `sh -c`, and Linux caps one argument at 128
 * KiB (MAX_ARG_STRLEN): forwarded file lists failed with a bare E2BIG.
 */
function argTooLongHint(bytes: number, wrapped: boolean, env?: NodeJS.ProcessEnv): string {
  const kib = Math.ceil(bytes / 1024)
  // The limit counts the environment too, and caps each entry as it does
  // one argument: a task's 4.4 MB `define` was blamed on its 1 KiB command.
  const vars = env === undefined ? null : envSize(env)
  if (vars !== null && (bytes <= MAX_ARG_STRLEN || vars.bytes > bytes)) {
    return (
      `the task environment is ${Math.ceil(vars.bytes / 1024)} KiB in ${vars.count} variables, ` +
      `largest ${vars.largest} at ${Math.ceil(vars.largestBytes / 1024)} KiB; Linux caps one ` +
      `entry at 128 KiB and the command with the environment at a quarter of the stack limit ` +
      `(often 2 MiB): pass large values through a file the tool reads`
    )
  }
  const what = wrapped ? "with the args after -- and the sandbox's wrap" : 'with the args after --'
  return (
    `the command, ${what}, is ${kib} KiB, and one argument to sh -c may hold at ` +
    `most 128 KiB on Linux: pass a long list through a file the tool reads (xargs, a response file)`
  )
}

/** What `execve` copies of an environment: each `name=value` and its NUL. */
function envSize(env: NodeJS.ProcessEnv): {
  bytes: number
  count: number
  largest: string
  largestBytes: number
} {
  let bytes = 0
  let count = 0
  let largest = ''
  let largestBytes = 0
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    const entry = Buffer.byteLength(name) + Buffer.byteLength(value) + 2
    bytes += entry
    count++
    if (entry > largestBytes) {
      largest = name
      largestBytes = entry
    }
  }
  return { bytes, count, largest, largestBytes }
}

/**
 * SRT refuses a wrap over the limit before spawning, so no E2BIG comes: the
 * same failure, said the same way.
 */
export function sandboxArgTooLongText(bytes: number): string {
  return `[vx] failed to spawn ${SANDBOXED_TASK}: argument list too long (E2BIG) — ${argTooLongHint(bytes, true)}\n`
}

/** A stop's own sweep, for a child it missed: the polite signal, then SIGKILL past the grace. */
async function stopLate(proc: Child, signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  const letGo = holdGroups([proc])
  try {
    killTree(proc, signal)
    for (const c of await untilGroupsGone([proc], killGraceMs(TIMEOUT_SIGKILL_GRACE_MS)))
      killTree(c, 'SIGKILL')
  } finally {
    letGo()
  }
}

export async function runCommand(opts: RunOptions): Promise<RunResult> {
  // Elapsed time, not wall time (an NTP step gave negative durations), minus
  // time vx was stopped.
  const start = runTime()
  const fullCommand = withForwardArgs(opts.command, opts.forwardArgs)

  let proc: Child
  // A spare shell takes the task when there is one (warm-shell.ts).
  const script =
    opts.terminal === true ? undefined : spareScript(opts.cwd, opts.env, execWrap(fullCommand))
  const spare = script === undefined ? undefined : takeSpare()
  const onSpare = spare === undefined ? undefined : await runOnSpare(spare, script!)
  const pipes = onSpare === undefined ? new TaskPipes(opts.terminal) : spare!.pipes
  const restoreModes = opts.terminal === true ? keepTerminalModes() : undefined
  if (onSpare !== undefined) proc = onSpare as unknown as Child
  else
    try {
      const stdio = taskStdio(opts.terminal, pipes)
      const argv = (guard: number | undefined): string[] =>
        shellArgv((guard === undefined ? '' : guardLine(3)) + execWrap(fullCommand))
      // Its own session and process group, so a kill reaches what it forked
      // (kill-tree.ts).
      const spawnOpts = {
        ...SH_ARGV0,
        cwd: opts.cwd,
        env: opts.env as Record<string, string>,
        detached: true,
      }
      // Descriptors cross to the spawn thread; Bun's own pipes (macOS) and a
      // terminal stay on this one.
      const fds = stdio.filter(
        (fd): fd is number | 'ignore' => typeof fd === 'number' || fd === 'ignore',
      )
      proc =
        fds.length === stdio.length
          ? // What vx reads of a child (pid, exit, usage, kill) is the same off
            // the thread; its streams are the pipes vx made (`TaskPipes`).
            ((await spawnGuarded((guard) =>
              spawnOff({
                cmd: argv(guard),
                ...spawnOpts,
                stdio: [...fds, ...(guard === undefined ? [] : [guard])],
              }),
            )) as unknown as Child)
          : spawnGuarded((guard) =>
              Bun.spawn(argv(guard), {
                ...spawnOpts,
                stdio: [...stdio, ...(guard === undefined ? [] : [guard])],
              }),
            )
    } catch (err) {
      pipes.close()
      const stderr = spawnFailureText(err, opts.cwd, 'task', fullCommand, opts.env)
      opts.onStderr?.(stderr)
      return {
        exitCode: 127,
        durationMs: Math.round(runTime() - start),
        stdout: '',
        stderr,
        spawnFailed: true,
      }
    } finally {
      pipes.spawned()
    }

  opts.liveChildren?.add(proc)
  // The spawn is awaited while the command runs: a stop landing then swept a
  // live set without it, and the run waited out the command.
  if (opts.signal?.aborted === true) void stopLate(proc, stopSignal(opts.signal.reason))
  opts.onSpawn?.(proc.pid)
  // Linux: the wait's peak includes vx's own, inherited at exec
  // (`rssFloorFor`); the tree sampled while running has the task's own.
  const watch = process.platform === 'linux' ? watchTree(proc.pid) : undefined
  const timeout = armTimeout(proc, opts.timeoutMs)
  const ac = new AbortController()
  const [out, err] = pipes.streams(proc)
  const ends = lineEnds(opts.onStdout, opts.onStderr)
  const streams = Promise.all([
    streamToString(out, ends.onStdout, ac.signal, opts.capture?.stdout ?? true),
    streamToString(err, ends.onStderr, ac.signal, opts.capture?.stderr ?? true),
  ]).finally(() => pipes.close())
  // Gate on the child's exit, not stream EOF: an orphaned grandchild (`server &
  // echo up`, or after a timeout) keeps the pipe open. A timeout aborts the
  // readers at once; otherwise `drainOrAbort` cuts a stuck reader after a
  // grace.
  await proc.exited
  // Stopped at the exit, before any return below: a watch left on kept
  // its timer reading /proc for the rest of the run.
  const looked = watch?.stop()
  restoreModes?.()
  await timeout.settle()
  let cut = false
  if (timeout.timedOut()) ac.abort()
  else cut = await drainOrAbort(streams, ac)
  const [stdout, streamed] = await streams
  ends.end()
  // A leftover of a task the run stopped is vx's doing, not the task's.
  const blame = cut && opts.signal?.aborted !== true
  const cutLine = ends.own(POST_EXIT_CUT_LINE)
  if (blame) opts.onStderr?.(cutLine)
  const stderr = blame ? streamed + cutLine : streamed
  // A leftover with stdio sent elsewhere holds no pipe to cut: its non-empty
  // group says so. One kill(0) when empty.
  const left = cut || groupAlive(proc)
  opts.liveChildren?.delete(proc)
  releaseGroup(proc)
  const exited = proc.exitCode ?? (proc.signalCode ? signalExitCode(proc.signalCode) : 1)
  // The spare's `cd` failed: the task never ran, as a spawn into a missing
  // directory throws. A 127 is the shell's own otherwise.
  if (onSpare !== undefined && exited === 127 && !existsSync(opts.cwd)) {
    const text = spawnFailureText(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      opts.cwd,
      'task',
    )
    opts.onStderr?.(text)
    return {
      exitCode: 127,
      durationMs: Math.round(runTime() - start),
      stdout,
      stderr: stderr + text,
      spawnFailed: true,
    }
  }
  // A timeout is a failure, whatever the child said: one that traps the
  // TERM and exits 0 reported success to every executor built on this.
  const exitCode = exited === 0 && timeout.timedOut() ? signalExitCode('SIGTERM') : exited
  return {
    exitCode,
    durationMs: Math.round(runTime() - start),
    stdout,
    stderr,
    ...(proc.signalCode != null ? { signal: proc.signalCode } : {}),
    ...(timeout.timedOut() ? { timedOut: true } : {}),
    ...(timeout.sigkilled() ? { killedAfterGrace: true } : {}),
    ...(left ? { leftRunning: true } : {}),
    ...usageOf(proc, looked),
  }
}

/** The CPU and peak a task used: the wait's, and the peak the looks saw when the wait's is vx's own. */
function usageOf(
  proc: Child,
  looked: TreeUsage | undefined,
): { cpuMs?: number; peakRssBytes?: number } {
  const usage = resourceUsageToCpuRss(proc.resourceUsage(), rssFloorFor)
  if (looked === undefined || looked.rssBytes <= 0) return usage
  return { ...usage, peakRssBytes: Math.max(usage.peakRssBytes ?? 0, looked.rssBytes) }
}

/**
 * This process's RSS high-water mark: the floor under which a child's
 * `ru_maxrss` says nothing. Linux folds the parent's mark into the child's at
 * exec, so a task lighter than vx reads vx's footprint (`true` read 44 MB).
 * Read after the child exits (the mark is monotonic). `VmHWM` on Linux;
 * elsewhere current RSS.
 */
export function ownRssHighWater(): number {
  // `VmHWM`, not getrusage's peak: that one includes the image this process
  // exec'd from, under vfork the parent's (vx spawned from a 300 MB runner read
  // a 300 MB floor).
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
 * The floor, read only when the last `VmHWM` cannot decide: the mark never
 * falls, so a peak within slack of an older reading stays within slack. After
 * the first light task the read (~35 µs per task) is skipped. A current-RSS
 * fallback is not monotonic and never reused.
 */
function rssFloorFor(peak: number): number {
  return peak <= highWaterSeen + RSS_FLOOR_SLACK_BYTES ? highWaterSeen : ownRssHighWater()
}

/**
 * What captured output keeps: the first `CAPTURE_HEAD_CHARS` and last
 * `CAPTURE_TAIL_CHARS` characters, the dropped middle counted in UTF-8 bytes
 * and named where it was. The live stream is never bounded, only vx's retained
 * copy for the entry and replay: a task printing 200 MB cost 620 MB of RSS on
 * every hit, and sat whole in `cache.db`.
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
 * A capture with `secrets` masked. The dropped middle could cut a value into a
 * head piece and a tail piece the whole-value mask missed.
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
const SIZE = '[\\d.]+ [KMGTP]?B'
const OWN_DROPPED_LINE = new RegExp(
  `\\n\\[vx\\] ([\\d.]+) ([KMGTP]?B) of output not kept — vx keeps the first ${SIZE} and the last ${SIZE} of a task's output\\n`,
  'y',
)
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * The dropped lines `chunks()` returned, known by the object, not the text:
 * a task's own chunk that read like one was copied past the mask.
 */
const droppedChunks = new WeakSet<CapturedChunk>()

/** Whether `chunk` is the line a `BoundedCapture` put where its dropped middle was (the object `chunks()` returned). */
export function isDroppedOutputChunk(chunk: CapturedChunk): boolean {
  return droppedChunks.has(chunk)
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/** One piece of a task's output and the stream it came on. */
export interface CapturedChunk {
  text: string
  /** True when the task wrote it to stderr. */
  err: boolean
}

/**
 * Head-and-tail accumulator: the head fills once, the tail is a chunk ring
 * trimmed from the front, so memory is bounded by both limits plus a chunk.
 * Chunks keep their stream, so one capture holds both in order.
 */
export class BoundedCapture {
  private readonly head: CapturedChunk[] = []
  private headLen = 0
  private readonly tail: CapturedChunk[] = []
  private tailLen = 0
  /** UTF-8 bytes: a count of UTF-16 units said a third of the bytes CJK text dropped. */
  private dropped = 0
  private seen = 0

  constructor(
    private readonly headChars = CAPTURE_HEAD_CHARS,
    private readonly tailChars = CAPTURE_TAIL_CHARS,
  ) {}

  push(text: string, err = false): void {
    // A capture's output replayed into another (a distributed miss replays the
    // worker's): its dropped line is counted, not kept, or it fell into the new
    // middle with a wrong count.
    const at = CAPTURE_HEAD_CHARS - this.seen
    this.seen += text.length
    if (!err && at >= 0 && at <= text.length) {
      // At the head's end, or a unit short of it (a surrogate pair's split).
      for (const i of [at, at - 1]) {
        if (i < 0) continue
        OWN_DROPPED_LINE.lastIndex = i
        const m = OWN_DROPPED_LINE.exec(text)
        if (m === null) continue
        this.dropped += Math.round(Number(m[1]) * 1024 ** UNITS.indexOf(m[2]!))
        this.add(text.slice(0, i), err)
        text = text.slice(i + m[0].length)
        break
      }
    }
    this.add(text, err)
  }

  private add(text: string, err: boolean): void {
    // Once the tail has begun the head is closed, or a later short chunk was
    // kept ahead of the one before it.
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
        this.dropped += Buffer.byteLength(first.text)
      } else {
        const cut = isHighSurrogate(first.text.charCodeAt(excess - 1)) ? excess + 1 : excess
        this.dropped += Buffer.byteLength(first.text.slice(0, cut))
        this.tail[0] = { text: first.text.slice(cut), err: first.err }
        this.tailLen -= cut
      }
    }
  }

  /**
   * The same output under tighter bounds, counting what this capture already
   * dropped. `through` maps chunks before the new cut (the store's mask), so
   * the cut cannot split a value first.
   */
  rebound(
    headChars: number,
    tailChars: number,
    through: (chunks: CapturedChunk[]) => CapturedChunk[] = (c) => c,
  ): BoundedCapture {
    const to = new BoundedCapture(headChars, tailChars)
    const sides = this.dropped === 0 ? [[...this.head, ...this.tail]] : [this.head, this.tail]
    for (const side of sides) for (const c of through(side)) to.push(c.text, c.err)
    to.dropped += this.dropped
    return to
  }

  /** The kept chunks in arrival order, the dropped middle named on stdout. */
  chunks(): CapturedChunk[] {
    if (this.dropped === 0) return [...this.head, ...this.tail]
    const line = {
      text: droppedOutputLine(this.dropped, this.headChars, this.tailChars),
      err: false,
    }
    droppedChunks.add(line)
    return [...this.head, line, ...this.tail]
  }

  text(): string {
    return this.chunks()
      .map((c) => c.text)
      .join('')
  }
}

/**
 * Drain a spawn stream, calling the live callback per UTF-8 chunk. Returns the
 * text, or `''` when not retained (the stream still drains fully).
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
  const decoder = new RawUtf8Decoder()
  // On abort, cancel the read so a pending `reader.read()` returns: a
  // grandchild holding the pipe means EOF never comes after a timeout.
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
 * How far above the parent's mark a child's `ru_maxrss` must read to count: a
 * light child sits on the floor, and per-thread RSS counters lag up to 64 pages
 * (a `true` from a 300 MB parent read 376 MB once in twelve CI runs). 4 MiB
 * clears the jitter and is below any reservation step (64 MB).
 */
export const RSS_FLOOR_SLACK_BYTES = 4 * 1024 * 1024

const MIN_PLAUSIBLE_PEAK_BYTES = 1024 * 1024

/**
 * A child's `maxRSS` in bytes, whatever unit the runtime reported. Bun 1.4
 * normalizes to bytes, but 1.3.11 passed raw kilobytes on Linux, and an
 * unconditional ×1024 once read 64 MB as 64 GB. So the number decides: no
 * process peaks under a megabyte, so a reading below that is kilobytes.
 * Calibrating against `process.resourceUsage()` is wrong: that node API reports
 * kilobytes even where the subprocess API reports bytes.
 */
export function peakRssBytes(maxRSS: number): number {
  return maxRSS > 0 && maxRSS < MIN_PLAUSIBLE_PEAK_BYTES ? maxRSS * 1024 : maxRSS
}

/**
 * CPU and RSS from Bun's resourceUsage() as ms and bytes; empty when
 * unavailable, recorded as NULLs.
 */
export function resourceUsageToCpuRss(
  usage: ReturnType<ReturnType<typeof Bun.spawn>['resourceUsage']>,
  /** The parent's own high-water mark (`ownRssHighWater`), or a function of the peak that answers it; a peak at or under it is inherited, not the child's, and is not reported. */
  floorBytes: number | ((peak: number) => number) = 0,
): { cpuMs?: number; peakRssBytes?: number } {
  if (!usage) return {}
  // cpuTime.total is microseconds as a bigint → ms.
  const cpuMs = Number(usage.cpuTime.total) / 1000
  // `maxRSS` in bytes by the rule above (`tests/runner.test.ts` checks unit and
  // floor end to end). A reading within the slack of the parent's mark is the
  // parent's: the child's peak is unknown.
  const peak = peakRssBytes(usage.maxRSS)
  const floor = typeof floorBytes === 'number' ? floorBytes : floorBytes(peak)
  return peak > floor + RSS_FLOOR_SLACK_BYTES ? { cpuMs, peakRssBytes: peak } : { cpuMs }
}

/** A limit as a config writes it: `'2s'` reads back `2s`, not `2000ms`. */
function asWritten(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`
}
