import { definePlugin, type VxPlugin } from '@vzn/vx'

// Run the `native` package's tasks in a container. The workspace is mounted
// at the same path, so outputs land where core looks for them. Every other
// task, and every sandboxed one, is declined and runs on the local executor.
export function inContainer(image: string): VxPlugin {
  return definePlugin(import.meta, {
    executor: () => ({
      name: `docker ${image}`,
      accepts: (task) => task.projectName === 'native' && !task.pinnedLocal,
      async execute(req) {
        const started = performance.now()
        const mount = `${req.workspaceRoot}:${req.workspaceRoot}`
        const argv = ['docker', 'run', '--rm', '-v', mount, '-w', req.cwd, image]
        const child = Bun.spawn([...argv, 'sh', '-c', req.command], { stdout: 'pipe' })
        const stdout = await new Response(child.stdout).text()
        req.onStdout(stdout)
        const exitCode = await child.exited
        return {
          exitCode,
          stdout,
          stderr: '',
          durationMs: performance.now() - started,
          violations: [],
        }
      },
    }),
  })
}
