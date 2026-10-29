// `executor`: where a task's command runs. This one runs it here, in a
// shell of its own, and stops the shell's whole process group when core
// aborts the request (a stop, or `exec.timeout`): core cannot reach a
// process an executor spawned.
import { definePlugin, withForwardArgs, type TaskExecutor, type VxPlugin } from '@vzn/vx'

export function shellExecutor(): VxPlugin {
  const executor: TaskExecutor = {
    name: 'shell',
    async execute(req) {
      const started = Date.now()
      // A stop before the spawn is work not to start: an abort fires no
      // listener added after it, so the command would run unstopped.
      if (req.signal?.aborted === true) {
        const exitCode = req.signal.reason === 'SIGINT' ? 130 : 143
        return { exitCode, durationMs: 0, stdout: '', stderr: '', violations: [], where: 'shell' }
      }
      // vx's own `sh`: a bare name is looked up on `req.env`'s PATH, which
      // leads with the project's node_modules/.bin, where a dependency's
      // `sh` would run every command.
      const sh = Bun.which('sh') ?? '/bin/sh'
      // The args after `--`, quoted and placed as the local executor places
      // them (before a trailing comment, never on a heredoc's terminator).
      const command = withForwardArgs(req.command, req.forwardArgs)
      const child = Bun.spawn([sh, '-c', command], {
        cwd: req.cwd,
        env: req.env,
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      })
      const kill = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-child.pid, signal)
        } catch {
          // already gone
        }
      }
      // Core abandons an executor 2 s after the abort: a group that ignores
      // SIGTERM is killed before then, or it would run on unreached.
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const stop = (): void => {
        kill('SIGTERM')
        killTimer = setTimeout(() => kill('SIGKILL'), 1_000)
      }
      req.signal?.addEventListener('abort', stop, { once: true })
      const readers: { cancel(): Promise<void> }[] = []
      const drain = async (stream: ReadableStream<Uint8Array>, on: (s: string) => void) => {
        const reader = stream.getReader()
        readers.push(reader)
        const decoder = new TextDecoder()
        let all = ''
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          const text = decoder.decode(r.value, { stream: true })
          all += text
          on(text)
        }
        return all
      }
      const drained = Promise.all([
        drain(child.stdout, req.onStdout),
        drain(child.stderr, req.onStderr),
      ])
      const exitCode = await child.exited
      // A pipe ends only when every writer closes it: a process the command
      // left running (`server &`) would hold the task open. What it writes
      // after a short grace is not the task's.
      const cut = setTimeout(() => readers.forEach((r) => void r.cancel()), 250)
      const [stdout, stderr] = await drained
      clearTimeout(cut)
      req.signal?.removeEventListener('abort', stop)
      clearTimeout(killTimer)
      return {
        exitCode,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        violations: [],
        where: 'shell',
      }
    },
  }
  return definePlugin(import.meta, { executor: () => executor })
}
