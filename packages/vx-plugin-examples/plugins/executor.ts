// `executor`: where a task's command runs. This one runs it here, in a
// shell of its own, and stops the shell's whole process group when core
// aborts the request (a stop, or `exec.timeout`): core cannot reach a
// process an executor spawned.
import { definePlugin, type TaskExecutor, type VxPlugin } from '@vzn/vx'

export function shellExecutor(): VxPlugin {
  const executor: TaskExecutor = {
    name: 'shell',
    async execute(req) {
      const started = Date.now()
      // vx's own `sh`: a bare name is looked up on `req.env`'s PATH, which
      // leads with the project's node_modules/.bin, where a dependency's
      // `sh` would run every command.
      const sh = Bun.which('sh') ?? '/bin/sh'
      const child = Bun.spawn([sh, '-c', [req.command, ...req.forwardArgs].join(' ')], {
        cwd: req.cwd,
        env: req.env,
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      })
      const stop = (): void => {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // already gone
        }
      }
      req.signal?.addEventListener('abort', stop, { once: true })
      const drain = async (stream: ReadableStream<Uint8Array>, on: (s: string) => void) => {
        const decoder = new TextDecoder()
        let all = ''
        for await (const chunk of stream) {
          const text = decoder.decode(chunk, { stream: true })
          all += text
          on(text)
        }
        return all
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        drain(child.stdout, req.onStdout),
        drain(child.stderr, req.onStderr),
        child.exited,
      ])
      req.signal?.removeEventListener('abort', stop)
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
