import { existsSync, readFileSync, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import path from 'node:path'
import { execWord, exitSignal } from '../exec/index.js'

/**
 * The frame line for a shell verdict the task's own output leaves a mystery.
 * `sh -c 'exec <word> …'` exits 127 ("not found") and 126 ("cannot
 * execute"), and its one line names the word and nothing about why: a bare
 * word is a PATH lookup, and the PATH is vx's (item 257); a word with a
 * slash is a file, and the file itself says why — missing, a directory, no
 * execute bit, a `#!` interpreter that is not there (dash and bash 5 say
 * "not found" and blame the file; bash 3.2 names it itself and exits 1),
 * or no `#!` line at all (item 258). An exit above 128 is the shell's
 * report of a death by signal, and the number alone says nothing about
 * what sent it — the OOM killer, a crash in native code, an abort, a
 * closed pipe (item 259).
 */
export function shellVerdict(args: {
  code: number
  command: string
  cwd: string
  bins: string[]
  /** The signal that killed the child when the runner saw one (`RunResult.signal`). */
  signal?: string | undefined
}): string | undefined {
  if (args.code !== 127 && args.code !== 126) return signalVerdict(args.code, args.signal)
  const word = execWord(args.command)
  const what = word ?? 'a command in this task'
  if (word !== undefined && word.includes('/')) {
    const file = path.resolve(args.cwd, word)
    return `[vx] exit ${args.code} is the shell's "${args.code === 127 ? 'not found' : 'cannot execute'}": ${word} ${fileVerdict(file)}`
  }
  if (args.code === 126) {
    return `[vx] exit 126 is the shell's "found but cannot execute": ${what} is not executable or is a directory — chmod +x it`
  }
  return `[vx] exit 127 is the shell's "command not found": ${what} is not on this task's PATH — vx puts ${args.bins.join(' and ')} first and never a sibling project's bin; install it in this package or at the workspace root`
}

/** Why the shell could not run a file, read from the file. */
function fileVerdict(file: string): string {
  if (!existsSync(file)) {
    return `does not exist — looked for ${file}, relative to the task's working directory`
  }
  let head: string
  try {
    const st = statSync(file)
    if (st.isDirectory()) return 'is a directory'
    if ((st.mode & 0o111) === 0) return 'is not executable — chmod +x it'
    head = readFileSync(file, 'latin1').slice(0, 256)
  } catch (err) {
    return `could not be read (${(err as Error).message})`
  }
  if (!head.startsWith('#!')) {
    return 'has no #! line, so it ran as a binary the loader refused — add a #! line or build it for this platform'
  }
  const nl = head.indexOf('\n')
  const line = head.slice(2, nl === -1 ? head.length : nl)
  if (line.endsWith('\r')) {
    return `exists, and its #! line ends in CRLF, so the interpreter the shell looked for is "${line.trim()}\\r" — convert the file to LF line endings`
  }
  const interp = line.trim().split(/\s+/)[0] ?? ''
  if (interp.startsWith('/') && !existsSync(interp)) {
    return `exists, and its #! interpreter ${interp} does not — install it or fix the line`
  }
  return `exists and is executable, and the shell still could not run it — check its #! line (${line.trim()})`
}

/** The signal behind an exit above 128, from the runner's own report or the code alone. */
function signalVerdict(code: number, signal: string | undefined): string | undefined {
  const signals = osConstants.signals as Partial<Record<string, number>>
  let name: string | undefined
  let num: number | undefined
  if (signal !== undefined) {
    name = signal
    num = signals[signal]
  } else {
    name = exitSignal(code)
    num = code - 128
  }
  if (name === undefined || num === undefined) return undefined
  // A SIGINT/SIGTERM the runner saw is a shutdown or an outside stop, and
  // the orchestrator reverts the task to aborted — that path has its own line.
  if (signal !== undefined && (signal === 'SIGINT' || signal === 'SIGTERM')) return undefined
  const why = SIGNAL_WHY[name] ?? 'the process was killed by that signal'
  const how =
    signal !== undefined
      ? `is how the shell reports a death by ${name} (${num})`
      : `is 128 + ${num}, the shell's report of a death by ${name} in the last command (or that command exited ${code} itself)`
  return `[vx] exit ${code} ${how}: ${why}`
}

const SIGNAL_WHY: Record<string, string> = {
  SIGKILL:
    "nothing catches it — on Linux the kernel's OOM killer (dmesg, or the memory limit of the container's cgroup) or an explicit kill; vx's own timeout reports itself as a timeout",
  SIGSEGV:
    'the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce',
  SIGBUS:
    'the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce',
  SIGILL:
    'the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce',
  SIGFPE:
    'the program crashed in native code (a native module, or the runtime itself) — re-run the command by hand to reproduce',
  SIGTRAP:
    "the program hit a breakpoint or a trap instruction — a debugger, or a runtime's fatal check",
  SIGABRT:
    "the program aborted itself — an assertion, or an allocator failure (a JS runtime's heap limit reports here)",
  SIGTERM:
    "something outside vx asked the process to stop (a runner's cancellation, a container stop, a kill)",
  SIGINT: 'something outside vx interrupted the process (a Ctrl-C reaching it, a kill -INT)',
  SIGHUP: 'the process lost its controlling terminal or session (a hangup, a closed SSH session)',
  SIGPIPE: 'it wrote to a pipe whose reader had gone — a reader in the command left early',
  SIGXCPU: "a CPU-time limit (ulimit -t, or a sandbox's) was hit",
  SIGXFSZ: 'a file-size limit (ulimit -f) was hit',
  SIGSYS: 'a system call was refused — a seccomp filter, or the sandbox',
  SIGQUIT: 'the process was sent a quit (Ctrl-\\, or a kill -QUIT); a core dump may be beside it',
}
