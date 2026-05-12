import path from 'node:path'
import type { TaskOutcome } from '../graph/scheduler.js'

/**
 * Write each task's captured stdout/stderr to
 * `<logsDir>/<project>__<task>.{stdout,stderr}`. Only writes files
 * with non-empty content. Group tasks and cache-hits leave stdout/
 * stderr empty, so they're naturally skipped. Errors during write are
 * swallowed — log persistence is best-effort, never blocks the run.
 * `Bun.write` auto-creates parent dirs.
 */
export async function persistTaskLogs(args: {
  logsDir: string
  outcomes: TaskOutcome[]
}): Promise<void> {
  const writable = args.outcomes.filter(
    (o) => (o.stdout && o.stdout.length > 0) || (o.stderr && o.stderr.length > 0),
  )
  if (writable.length === 0) return
  await Promise.all(
    writable.flatMap((o) => {
      const stem = `${o.node.projectName}__${o.node.taskName}`.replace(/[^a-zA-Z0-9._-]/g, '_')
      const tasks: Promise<unknown>[] = []
      if (o.stdout && o.stdout.length > 0) {
        tasks.push(Bun.write(path.join(args.logsDir, `${stem}.stdout`), o.stdout).catch(() => {}))
      }
      if (o.stderr && o.stderr.length > 0) {
        tasks.push(Bun.write(path.join(args.logsDir, `${stem}.stderr`), o.stderr).catch(() => {}))
      }
      return tasks
    }),
  )
}
