import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import path from 'node:path'
import { execWord, exitSignal } from '../exec/index.js'

/**
 * The frame line for a shell verdict the task's own output leaves a mystery.
 * `sh -c 'exec <word> …'` exits 127 ("not found") and 126 ("cannot execute"),
 * and its one line names the word and nothing about why: a bare word is a PATH
 * lookup, and the PATH is vx's; a word with a slash is a file, and the file
 * itself says why — missing, a directory, no execute bit, a `#!` interpreter
 * that is not there (dash and bash 5 say "not found" and blame the file; bash
 * 3.2 names it itself and exits 1), or no `#!` line at all. An exit above 128
 * is the shell's report of a death by signal, and the number alone says nothing
 * about what sent it — the OOM killer, a crash in native code, an abort, a
 * closed pipe.
 */
export function shellVerdict(args: {
  code: number
  command: string
  cwd: string
  bins: string[]
  /** The signal that killed the child when the runner saw one (`RunResult.signal`). */
  signal?: string | number | undefined
  /** A sandboxed task's view: whether a file is hidden from it (no grant reads it). */
  hidden?: ((file: string) => boolean) | undefined
  /** What the step wrote to stderr: the shell's own "not found" line names the word a compound command missed. */
  stderr?: string | undefined
}): string | undefined {
  if (args.code !== 127 && args.code !== 126) return signalVerdict(args.code, args.signal)
  const word = execWord(args.command) ?? (args.code === 127 ? notFoundWord(args.stderr) : undefined)
  const what = word ?? 'a command in this task'
  if (word !== undefined && word.includes('/')) {
    const file = path.resolve(args.cwd, word)
    // The file the host has may be one the sandbox does not: then the
    // shell's "not found" is the sandbox's, and the file's own state (its
    // `#!` line) is not the reason.
    const verdict =
      existsSync(file) && args.hidden?.(file) === true
        ? `exists, but no sandbox grant reads it, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`
        : fileVerdict(file)
    return `[vx] exit ${args.code} is the shell's "${args.code === 127 ? 'not found' : 'cannot execute'}": ${word} ${verdict}`
  }
  if (args.code === 126) {
    return `[vx] exit 126 is the shell's "found but cannot execute": ${what} is not executable or is a directory — chmod +x it`
  }
  // A program the host's PATH has may be one the sandbox hides (a
  // hermetic task sees no /usr/bin): the reason is a grant, not an install.
  const taskPath = [...args.bins, process.env['PATH'] ?? ''].join(path.delimiter)
  const found = word === undefined ? null : Bun.which(word, { PATH: taskPath })
  if (found !== null && args.hidden?.(found) === true) {
    return `[vx] exit 127 is the shell's "command not found": ${word} is ${found} on the host, but no sandbox grant reads it, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`
  }
  // The program is there, and what it needs is not: its `#!` runtime
  // (`/usr/bin/env node` under a hermetic task) or a library the runtime
  // links. Said "not on PATH, install it", which sent the reader the wrong way.
  if (word !== undefined && args.hidden !== undefined) {
    const runtime = hiddenRuntime(found, args.hidden, args.stderr)
    if (runtime !== undefined)
      return `[vx] exit 127 is the shell's "not found": ${word} is there, but ${runtime}, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`
  }
  // Found, and its `#!` interpreter is not: `vite` with no node installed.
  // "vite is not on this task's PATH" sent the reader to install vite.
  if (found !== null) {
    const missing = missingInterpreter(found, taskPath, args.stderr)
    if (missing !== undefined)
      return `[vx] exit 127 is the shell's "not found": ${word} is ${found}, but ${missing} — install it, or put it on PATH`
  }
  const unnamed = args.bins.find((dir) => dir.includes(path.delimiter))
  if (unnamed !== undefined) {
    return `[vx] exit 127 is the shell's "command not found": ${what} is not on this task's PATH — ${unnamed} holds "${path.delimiter}", which PATH reads as a separator, so vx cannot put it there; move the workspace to a path without "${path.delimiter}"`
  }
  return `[vx] exit 127 is the shell's "command not found": ${what} is not on this task's PATH — vx puts ${args.bins.join(' and ')} first and never a sibling project's bin; install it in this package or at the workspace root`
}

/**
 * The word the shell's last "not found" line names: dash's `sh: 1: cat:
 * not found`, bash's `bash: line 1: cat: command not found`. A command with
 * a redirect or a `&&` has no one word to read from the command itself, and
 * a hermetic task's hidden `cat` was told to be installed (almost every
 * real command has one).
 */
function notFoundWord(stderr: string | undefined): string | undefined {
  if (stderr === undefined) return undefined
  const lines = stderr.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /: ([^:]+): (?:command )?not found$/.exec(lines[i]!.trimEnd())
    if (m !== null) return m[1]
  }
  return undefined
}

/** Where a loader looks for a library, by convention: a hidden one is named by its host path. */
const LIBRARY_DIRS = [
  '/lib/x86_64-linux-gnu',
  '/usr/lib/x86_64-linux-gnu',
  '/lib/aarch64-linux-gnu',
  '/usr/lib/aarch64-linux-gnu',
  '/lib64',
  '/usr/lib64',
  '/lib',
  '/usr/lib',
]

/**
 * What a found program needs that the sandbox hides, said as a clause: the
 * library its loader could not open, or the runtime its `#!/usr/bin/env`
 * line names, looked up on the host's PATH.
 */
function hiddenRuntime(
  found: string | null,
  hidden: (file: string) => boolean,
  stderr: string | undefined,
): string | undefined {
  const lib =
    /error while loading shared libraries: ([^:\s]+): cannot open shared object file/.exec(
      stderr ?? '',
    )?.[1]
  if (lib !== undefined) {
    const at = LIBRARY_DIRS.map((d) => path.join(d, lib)).find((f) => existsSync(f) && hidden(f))
    return at === undefined
      ? `the loader could not open ${lib}, a library its runtime links, which no sandbox grant reads`
      : `the library its runtime links, ${at} on the host, is read by no sandbox grant`
  }
  // env's own line names the runtime it looked for: `/usr/bin/env: 'node':
  // No such file or directory`. The host's copy is where to grant.
  const missing = /env: '?([^':\s]+)'?: No such file or directory/.exec(stderr ?? '')?.[1]
  const name = missing ?? (found === null ? undefined : envRuntime(found))
  if (name === undefined) return undefined
  const runtime = Bun.which(name, { PATH: process.env['PATH'] ?? '' })
  if (runtime === null || (missing === undefined && !hidden(runtime))) return undefined
  return `its runtime ${name} is ${runtime} on the host, read by no sandbox grant`
}

/** The `#!` interpreter `file` names that is not there, said as a clause; none when it is. */
function missingInterpreter(
  file: string,
  taskPath: string,
  stderr: string | undefined,
): string | undefined {
  const named = /env: '?([^':\s]+)'?: No such file or directory/.exec(stderr ?? '')?.[1]
  const name = named ?? envRuntime(file)
  if (name !== undefined) {
    if (named === undefined && Bun.which(name, { PATH: taskPath }) !== null) return undefined
    return `its #! line runs ${name}, which is not on this task's PATH`
  }
  const interp = shebang(file)?.[0]
  if (interp === undefined || !interp.startsWith('/') || existsSync(interp)) return undefined
  return `its #! interpreter ${interp} does not exist`
}

/** A file's `#!` line as words; none without one. */
function shebang(file: string): string[] | undefined {
  let head: string
  try {
    head = readFileSync(file).subarray(0, 256).toString('utf8')
  } catch {
    return undefined
  }
  if (!head.startsWith('#!')) return undefined
  const nl = head.indexOf('\n')
  return head
    .slice(2, nl === -1 ? head.length : nl)
    .trim()
    .split(/\s+/)
}

/** The runtime a `#!/usr/bin/env <name>` line names; none for any other line. */
function envRuntime(file: string): string | undefined {
  const [interp = '', arg] = shebang(file) ?? []
  if (path.basename(interp) !== 'env' || arg === undefined || arg.startsWith('-')) return undefined
  return arg
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
    // Ask the kernel: an execute bit for the group or others does not
    // make a file this user owns executable to this user (root aside).
    if (!executable(file)) return 'is not executable — chmod +x it'
    // The kernel reads the #! line as bytes, and a path's bytes are its
    // UTF-8: a latin1 read named a present non-ASCII interpreter missing.
    head = readFileSync(file).subarray(0, 256).toString('utf8')
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
function signalVerdict(code: number, signal: string | number | undefined): string | undefined {
  if (typeof signal === 'number') {
    return `[vx] exit ${code} is how the shell reports a death by signal ${signal}: the process was killed by that signal`
  }
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

function executable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The frame line for a failure whose last output names a variable vx's own
 * environment holds and the task's does not. A task sees only what
 * `passThrough` and `define` name, so `prisma migrate` in a shell that
 * exports `DATABASE_URL` failed "variable not found" with no word on why.
 * Names only, upper-case and four characters or more, whole words of the
 * output; never a value.
 */
export function unpassedEnv(
  tail: string,
  given: NodeJS.ProcessEnv,
  host: NodeJS.ProcessEnv,
): string | undefined {
  const named = new Set(tail.match(/(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]{3,}(?![A-Za-z0-9_])/g) ?? [])
  const missing = [...named]
    .filter((n) => Object.hasOwn(host, n) && !Object.hasOwn(given, n))
    .sort()
    .slice(0, 5)
  if (missing.length === 0) return undefined
  const one = missing.length === 1
  return (
    `[vx] ${missing.join(', ')} ${one ? 'is' : 'are'} set in your environment, but this task does not get ` +
    `${one ? 'it' : 'them'}: a task sees only the variables exec.env.passThrough and define name — add ` +
    `${one ? 'it' : 'them'} to passThrough, and to inputs.env if the output depends on ${one ? 'it' : 'them'}`
  )
}
