import { definePlugin, type VxPlugin } from '@vzn/vx'

// Write the ids of the failed tasks to a file a later CI step can read.
// The summary is kept in memory; the write happens in flush, which the run awaits.
export function failedTasksFile(path: string): VxPlugin {
  let failed: string[] = []
  return definePlugin(import.meta, {
    telemetry: () => ({
      onRunSummary(run) {
        failed = run.tasks.filter((t) => t.status === 'failed').map((t) => t.taskId)
      },
      flush: async () => void (await Bun.write(path, failed.join('\n'))),
    }),
  })
}
