// Sandbox — enforces declared cache.inputs.files by running the task
// inside a constrained filesystem view. Undeclared reads fail with ENOENT.
//
// Linux: bwrap (bubblewrap) — user namespaces + mount namespaces.
// macOS: sandbox-exec with a generated seatbelt profile.
// Other (Windows, BSD): unsupported; the orchestrator warns and falls
// through to direct execution.
//
// See docs/design/sandbox.md for the full design rationale.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shellQuote, type RunResult } from './runner.js'

export type SandboxPlatform = 'linux' | 'darwin' | 'unsupported'

export interface SandboxArgs {
  /** Shell command to run inside the sandbox (single command, not argv). */
  command: string
  /** Working directory inside the sandbox. */
  cwd: string
  /** Environment passed to the child process. */
  env: NodeJS.ProcessEnv
  /** Args appended (shell-quoted) to `command` before execution. */
  forwardArgs?: readonly string[] | undefined
  /** Project directory: bound read-write so outputs can be produced. */
  projectDir: string
  /** Resolved declared input files. Bound read-only into the sandbox. */
  inputFiles: readonly string[]
  /** Live stdout chunks. */
  onStdout?: (chunk: string) => void
  /** Live stderr chunks. */
  onStderr?: (chunk: string) => void
}

export class SandboxUnsupportedError extends Error {
  constructor(public readonly platform: NodeJS.Platform) {
    super(`sandbox is not supported on ${platform}`)
    this.name = 'SandboxUnsupportedError'
  }
}

export class SandboxToolMissingError extends Error {
  constructor(public readonly tool: string) {
    super(`sandbox requires \`${tool}\` on PATH but it was not found`)
    this.name = 'SandboxToolMissingError'
  }
}

/** Detect the host's sandbox capability. */
export function detectPlatform(): SandboxPlatform {
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'darwin'
  return 'unsupported'
}

/**
 * True if the host can run sandboxed tasks. False on Windows, BSDs, etc.,
 * AND on Linux/macOS when the required helper binary isn't installed.
 */
export function isSandboxSupported(): boolean {
  const p = detectPlatform()
  if (p === 'linux') return hasExecutable('bwrap')
  if (p === 'darwin') return hasExecutable('sandbox-exec')
  return false
}

/**
 * Run a task inside a sandbox. Throws SandboxUnsupportedError on Windows
 * etc.; throws SandboxToolMissingError when the helper binary isn't found.
 * The orchestrator chooses fail-loud over silent fall-through — silent
 * fall-through would defeat the contract the user asked for.
 */
export async function runSandboxed(args: SandboxArgs): Promise<RunResult> {
  const platform = detectPlatform()
  if (platform === 'unsupported') throw new SandboxUnsupportedError(process.platform)
  if (platform === 'linux') {
    if (!hasExecutable('bwrap')) throw new SandboxToolMissingError('bwrap')
    return await runBwrap(args)
  }
  if (!hasExecutable('sandbox-exec')) throw new SandboxToolMissingError('sandbox-exec')
  return await runSandboxExec(args)
}

// --- Linux: bwrap ----------------------------------------------------

async function runBwrap(args: SandboxArgs): Promise<RunResult> {
  const fullCommand = appendForwardArgs(args.command, args.forwardArgs)
  // Bind a minimal essential surface (binaries + libs + /etc) read-only,
  // bind the project read-write, bind each declared input read-only.
  // tmpfs for /tmp, fresh /proc and /dev, and chdir into the project.
  // --ro-bind-try: ignore sources that don't exist on this host's distro.
  const argv = [
    'bwrap',
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--ro-bind-try',
    '/lib32',
    '/lib32',
    '--ro-bind-try',
    '/etc',
    '/etc',
    '--ro-bind-try',
    '/bin',
    '/bin',
    '--ro-bind-try',
    '/sbin',
    '/sbin',
    '--tmpfs',
    '/tmp',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--bind',
    args.projectDir,
    args.projectDir,
  ]
  for (const f of args.inputFiles) {
    argv.push('--ro-bind-try', f, f)
  }
  argv.push('--chdir', args.cwd, 'sh', '-c', fullCommand)

  return await spawnAndStream(argv, args)
}

// --- macOS: sandbox-exec --------------------------------------------

async function runSandboxExec(args: SandboxArgs): Promise<RunResult> {
  const fullCommand = appendForwardArgs(args.command, args.forwardArgs)
  const profile = buildSeatbeltProfile(args.projectDir, args.inputFiles)
  // sandbox-exec reads the profile from a file. Write to a temp file in
  // the OS tmpdir (outside the sandbox itself), pass with -f.
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'vzn-seatbelt-'))
  const profilePath = path.join(tmp, 'profile.sb')
  await writeFile(profilePath, profile)
  try {
    const argv = ['sandbox-exec', '-f', profilePath, 'sh', '-c', fullCommand]
    return await spawnAndStream(argv, args)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function buildSeatbeltProfile(projectDir: string, inputFiles: readonly string[]): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow network*)',
    // Standard system paths the tooling needs.
    '(allow file-read* (regex #"^/usr(/|$)"))',
    '(allow file-read* (regex #"^/bin(/|$)"))',
    '(allow file-read* (regex #"^/sbin(/|$)"))',
    '(allow file-read* (regex #"^/etc(/|$)"))',
    '(allow file-read* (regex #"^/var/folders/"))',
    '(allow file-read* (regex #"^/private/var/folders/"))',
    '(allow file-read* (regex #"^/System/"))',
    '(allow file-read* (regex #"^/Library/"))',
    '(allow file-read* (regex #"^/dev/"))',
    // Scratch dirs.
    `(allow file-read* file-write* (regex #"^/tmp(/|$)"))`,
    `(allow file-read* file-write* (regex #"^/private/tmp(/|$)"))`,
    // Project dir: full r/w.
    `(allow file-read* file-write* (regex #"^${escapeForSeatbeltRegex(projectDir)}(/|$)"))`,
  ]
  for (const f of inputFiles) {
    lines.push(`(allow file-read* (literal "${f.replace(/"/g, '\\"')}"))`)
  }
  return lines.join('\n') + '\n'
}

function escapeForSeatbeltRegex(p: string): string {
  return p.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

// --- shared spawn + stream + collect ---------------------------------

function spawnAndStream(argv: string[], args: SandboxArgs): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const [bin, ...rest] = argv
    const proc = spawn(bin!, rest, {
      cwd: args.cwd,
      env: args.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      args.onStdout?.(chunk)
    })
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      args.onStderr?.(chunk)
    })

    proc.on('error', (err) => {
      stderr += `\n[vzn] sandbox spawn failed: ${err.message}\n`
      resolve({ exitCode: 127, durationMs: Date.now() - start, stdout, stderr })
    })

    proc.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? 130 : 1)
      resolve({ exitCode, durationMs: Date.now() - start, stdout, stderr })
    })
  })
}

function appendForwardArgs(command: string, forwardArgs?: readonly string[]): string {
  if (!forwardArgs || forwardArgs.length === 0) return command
  return command + ' ' + forwardArgs.map(shellQuote).join(' ')
}

function hasExecutable(name: string): boolean {
  // `command -v` is POSIX; `which` isn't required.
  const r = spawnSync('sh', ['-c', `command -v ${shellQuote(name)}`], {
    stdio: 'ignore',
  })
  return r.status === 0
}
