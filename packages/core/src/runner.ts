import { spawn } from 'node:child_process'

export interface RunResult {
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Called for each chunk of stdout/stderr as it arrives, for live output. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export function runCommand(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const proc = spawn(opts.command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk
      opts.onStdout?.(chunk)
    })
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk
      opts.onStderr?.(chunk)
    })

    proc.on('error', (err) => {
      stderr += `\n[nxt] failed to spawn: ${err.message}\n`
      resolve({ exitCode: 127, durationMs: Date.now() - start, stdout, stderr })
    })

    proc.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? 130 : 1)
      resolve({ exitCode, durationMs: Date.now() - start, stdout, stderr })
    })
  })
}
