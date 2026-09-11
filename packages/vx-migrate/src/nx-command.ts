// What an `nx:run-commands` target (or a plain `command`) runs as under
// vx. Nx interpolates `{projectRoot}`, `{projectName}` and
// `{workspaceRoot}` into the command and runs it from the WORKSPACE ROOT
// unless `options.cwd` says otherwise; vx runs every command from the
// project dir and has no per-task cwd. So the command is expanded here
// and, when Nx would have run it elsewhere, prefixed with the `cd` that
// gets there — `cd ../.. && node ./scripts/build/build-package.ts --cwd
// code/lib/cli` is exactly what storybook's `compile` does (2026-09-11).
// Before this, a root-relative command ran from the project dir and
// found nothing, and `cwd: '{projectRoot}'` earned a spurious todo.

import path from 'node:path'

export interface NxCommandContext {
  /** Project dir relative to the workspace root, `.` for the root. */
  projectRel: string
  /** The Nx project name, what `{projectName}` expands to. */
  projectName: string
  /** `options.cwd` as declared, if any. */
  cwd?: unknown
}

function relPosix(from: string, to: string): string {
  const rel = path.posix.relative(from, to)
  return rel === '' ? '.' : rel
}

/** `{workspaceRoot}` etc. as Nx expands them, relative to the workspace root. */
function expand(s: string, ctx: NxCommandContext): string {
  return s
    .replaceAll('{workspaceRoot}', '.')
    .replaceAll('{projectRoot}', ctx.projectRel)
    .replaceAll('{projectName}', ctx.projectName)
}

/**
 * The shell command for `command`, run where Nx would have run it.
 * `todos` receives what could not be represented (`{args.x}`).
 */
export function nxRunCommand(command: string, ctx: NxCommandContext, todos: string[]): string {
  const expanded = expand(command, ctx)
  if (/\{args\.[^}]*\}/.test(expanded)) {
    todos.push(
      '`{args.*}` in the command: params forwarding is not supported — pass the value in the command',
    )
  }
  // Where Nx ran it: the workspace root by default.
  const cwdRel =
    typeof ctx.cwd === 'string' && ctx.cwd.length > 0
      ? path.posix.normalize(expand(ctx.cwd, ctx)).replace(/\/$/, '') || '.'
      : '.'
  const projectDir = ctx.projectRel === '' ? '.' : ctx.projectRel
  if (cwdRel === projectDir) return expanded
  // `cd` from the project dir to where Nx ran it; a command that reads
  // `{workspaceRoot}` as `.` is right there once the cd has happened.
  const hop = relPosix(projectDir, cwdRel)
  return `cd ${hop} && ${expanded}`
}
