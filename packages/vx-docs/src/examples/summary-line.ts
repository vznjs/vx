import { definePlugin, type VxPlugin } from '@vzn/vx'

// One line after every run: how many tasks ran, how many failed, how many
// came from a cache, and how long the run took.
export function summaryLine(): VxPlugin {
  return definePlugin(import.meta, {
    telemetry: () => ({
      name: 'summary-line',
      // No per-task records: the summary arrives either way.
      wants: [],
      onRunSummary(run) {
        const seconds = (run.totalDurationMs / 1000).toFixed(1)
        console.log(
          `${run.taskCount} tasks, ${run.failedCount} failed, ${run.hitCount} from cache, ${seconds} s`,
        )
      },
    }),
  })
}
