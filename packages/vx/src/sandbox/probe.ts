// The checks behind `probeSandbox` (session.ts): whether this host can
// sandbox at all, and why not in the user's terms when it cannot.

import path from 'node:path'
import os from 'node:os'
import { ESSENTIAL_ENV, helperEnv, taskShell, isTmpdirRefusal, TMPDIR_HINT } from '../util/index.js'
import type { SrtModule } from './session.js'
import { sandboxTmpdir } from './tmp.js'

export interface SandboxAvailability {
  available: boolean
  /** Reason it isn't available (platform / missing deps). Empty when available. */
  reason: string
}

/**
 * Can a seatbelt policy be applied in THIS process at all?
 *
 * Not if one already is: macOS refuses `sandbox_apply` inside a sandbox,
 * at any permission level — an inner profile of `(allow default)` still
 * dies `sandbox_apply: Operation not permitted` (exit 71, measured
 * 2026-09-05). No grant fixes it, so the honest verdict is "unavailable",
 * which is what stops a sandboxed task from spawning tasks that report
 * a sandbox they never got. One `/usr/bin/true`, memoized with the rest.
 */
export function applyPolicyHere(): SandboxAvailability {
  const proc = Bun.spawnSync({
    cmd: ['sandbox-exec', '-p', '(version 1)(allow default)', '/usr/bin/true'],
    env: helperEnv(),
    stdout: 'ignore',
    stderr: 'pipe',
  })
  if (proc.exitCode === 0) return { available: true, reason: '' }
  const stderr = proc.stderr.toString().trim()
  if (stderr.includes('sandbox_apply')) {
    return {
      available: false,
      reason:
        'this process is already sandboxed and macOS cannot nest one — a task that ' +
        'itself sandboxes has to run without `exec.sandbox` of its own',
    }
  }
  return { available: false, reason: `sandbox-exec failed: ${stderr || `exit ${proc.exitCode}`}` }
}

/**
 * Why the probe's sandboxed `true` failed, in the user's terms. The hint
 * names the CONFIG field (`exec.sandbox.weakerWhenNested`), not the
 * runtime option it maps to — a user who followed the runtime's name into
 * their config met the loader's unknown-field refusal instead of a fix
 * (`tests/sandbox-hint.test.ts` pins every field the hint names against
 * the loader).
 */
export function unavailableReason(exitCode: number | null, stderr: string): string {
  const hint = stderr.includes('capability-restricted')
    ? // Ubuntu 25.04+ confines bwrap with this AppArmor profile (2026-10-23).
      " — AppArmor's bwrap-userns-restrict profile strips the capabilities of the seccomp helper's nested user namespace: replace it with a profile for /usr/bin/bwrap that grants `userns,` (https://discourse.ubuntu.com/t/58007)"
    : stderr.includes('uid_map')
      ? " — the runtime's seccomp helper cannot create its nested user namespace here (root inside a container, or a kernel that forbids nested user namespaces): run as a non-root user, or set `sandbox.weakerWhenNested: true` on every sandboxed task"
      : stderr.includes("Can't mount proc")
        ? ' — a fresh /proc cannot be mounted here (an unprivileged container, or a sandbox around vx): set `sandbox.weakerWhenNested: true` on every sandboxed task'
        : ''
  return `a sandboxed \`true\` failed (exit ${exitCode}): ${stderr.slice(0, 200)}${hint}`
}

/** vx's values of the variables every task gets (`ESSENTIAL_ENV`). */
function essentialEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ESSENTIAL_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

export async function trySandboxedTrue(
  SandboxManager: SrtModule['SandboxManager'],
  weakerNested: boolean,
): Promise<SandboxAvailability> {
  try {
    // SRT reads the flag off its run-wide config, never the per-call one.
    const live = SandboxManager.getConfig()
    if (weakerNested && live !== undefined) {
      SandboxManager.updateConfig({ ...live, enableWeakerNestedSandbox: true })
    }
    let wrapped: string
    try {
      wrapped = await SandboxManager.wrapWithSandbox('true')
    } finally {
      if (weakerNested && live !== undefined) SandboxManager.updateConfig(live)
    }
    const proc = Bun.spawn([taskShell(), '-c', wrapped], {
      argv0: 'sh',
      // What a task gets of vx's env: the probe is a sandboxed `true`.
      env: essentialEnv(),
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const stderr = (await new Response(proc.stderr).text()).trim()
    await proc.exited
    if (proc.exitCode === 0) return { available: true, reason: '' }
    return { available: false, reason: unavailableReason(proc.exitCode, stderr) }
  } catch (err) {
    return { available: false, reason: thrownReason(err, 'sandbox probe threw') }
  }
}

/**
 * The runtime's own dependency check names what is missing ("ripgrep (rg)
 * not found") and nothing else. On Linux it needs three binaries — bwrap
 * for the namespaces, socat for the network bridge, ripgrep to expand its
 * mandatory deny globs — and the docs named two of them until a minimal
 * image with the two failed on the third (2026-09-16). Name the set and
 * the install.
 */
export function dependencyReason(errors: readonly string[]): string {
  const need =
    process.platform === 'linux'
      ? 'the sandbox runtime needs bubblewrap (bwrap), socat and ripgrep (rg) on PATH'
      : 'the sandbox runtime is missing a dependency'
  return `${need}: ${errors.join('; ')} — install it (Linux: apt install bubblewrap socat ripgrep, or the same names in your package manager) and re-run`
}

/**
 * The runtime listens on `<tmpdir>/srt-mux-<pid>-<seq>.sock`, and a unix
 * socket path has a hard length (`sun_path`: 108 bytes on Linux, 104 on
 * macOS, one of them the NUL). Past it the runtime says "ENAMETOOLONG …
 * listen" on macOS and "Failed to create bridge sockets after 5 attempts"
 * on Linux (its retry loop swallows the code), neither naming the
 * directory (2026-09-16). Checked up front, with room for the sequence.
 * On Linux the longer name is the network bridge's,
 * `claude-http-<16 hex>.sock`, and it is the one that fails there.
 *
 * Both directories that hold sockets are also checked for what the paths
 * pass through: `tmpdir`, where the runtime puts its bridges, and
 * `taskTmp`, the parent of vx's own task temp directories (`taskTmpdir`).
 */
export function socketPathRefusal(
  tmpdir = os.tmpdir(),
  taskTmp = sandboxTmpdir(),
): string | undefined {
  const unsafe =
    unquotableSocketDir(tmpdir, 'TMPDIR') ?? unquotableSocketDir(taskTmp, 'CLAUDE_CODE_TMPDIR')
  if (unsafe !== undefined) return unsafe
  const sample = path.join(
    tmpdir,
    process.platform === 'linux'
      ? `claude-http-${'0'.repeat(16)}.sock`
      : `srt-mux-${process.pid}-zzz.sock`,
  )
  const limit = process.platform === 'darwin' ? 103 : 107
  const length = Buffer.byteLength(sample)
  if (length <= limit) return undefined
  return `the sandbox runtime listens on a unix socket under the temp directory, and ${sample} is ${length} bytes where the OS allows ${limit} — point TMPDIR at a shorter path`
}

/**
 * The runtime pastes its bridge socket's path unquoted into the shell
 * script it runs inside the sandbox and into socat addresses on the host,
 * and vx's port bridges hand theirs to socat and splice them into bwrap's
 * command line. Shell splits on whitespace and its metacharacters, socat on
 * `:` `,` `!` and `\`, and a relative path names another directory inside
 * the sandbox: `;` hung the run, a space cost every task ~7 s and its
 * network proxy, `,` failed "Failed to create bridge sockets" (2026-11-10).
 * Each character this lets through was run as both directories. Not a
 * non-ASCII letter: the runtime quotes it in the command it hands back, and
 * a networked task's proxy front, found by the bare path, was not swapped in.
 */
const SOCKET_DIR = /^\/[A-Za-z0-9._\-/+@]*$/

function unquotableSocketDir(dir: string, variable: string): string | undefined {
  if (SOCKET_DIR.test(dir)) return undefined
  const why = path.isAbsolute(dir) ? 'holds a character they cannot carry' : 'is not absolute'
  return `the sandbox runtime writes socket paths under ${variable} unquoted into shell and socat commands, and ${JSON.stringify(dir)} ${why} — point ${variable} at an absolute path of ASCII letters, digits and . _ - / + @`
}

/**
 * A throw from the runtime itself, in the user's terms. Its own temp files
 * (the observer directory, the bridge sockets, the strace log) live under
 * `os.tmpdir()`, so a temp directory that is missing or not writable
 * failed a sandboxed task with a path and no knob ("EACCES … mkdtemp
 * '/tmp/probe-ro/srt-obs-…'", a minimal image, 2026-09-16).
 */
export function thrownReason(err: unknown, what = ''): string {
  const message = err instanceof Error ? err.message : String(err)
  if (isTmpdirRefusal(err)) {
    return `the sandbox runtime needs a writable temp directory and ${os.tmpdir()} is not one (${message}) — ${TMPDIR_HINT}`
  }
  return what === '' ? message : `${what}: ${message}`
}
