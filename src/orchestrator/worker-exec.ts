// Worker-side execution primitive — what `vx run --worker` calls to
// execute a coordinator-assigned task. Lives in orchestrator/ so cli/
// can call it without violating the module-boundary rule
// (cli → exec is intentionally absent; cli → orchestrator is fine).
//
// Thin wrapper: spawn the command, stream stdout/stderr to the caller,
// return exitCode + duration. No sandbox, no cache (the worker is
// "compute fungible" — caching happens via the remote layer if at all).

import { runCommand } from '../exec/index.js'

export interface WorkerExecArgs {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export interface WorkerExecResult {
  exitCode: number
  durationMs: number
}

export async function workerExecute(args: WorkerExecArgs): Promise<WorkerExecResult> {
  const t0 = Date.now()
  const opts: Parameters<typeof runCommand>[0] = {
    command: args.command,
    cwd: args.cwd,
    env: args.env,
  }
  if (args.onStdout) opts.onStdout = args.onStdout
  if (args.onStderr) opts.onStderr = args.onStderr
  const result = await runCommand(opts)
  return {
    exitCode: result.exitCode,
    durationMs: Date.now() - t0,
  }
}
