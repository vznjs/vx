// `telemetry`: who observes. One JSON line per run, appended to a file.
// Observability never breaks a run: a sink that throws is switched off,
// and `flush` is where slow I/O goes (core bounds it).
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'

export function jsonlTelemetry(file: string): VxPlugin {
  return definePlugin(import.meta, {
    telemetry(ctx) {
      // From the root, not the cwd: a run in a project's directory appends
      // to the same file as one at the root.
      const to = path.resolve(ctx.workspaceRoot, file)
      const lines: string[] = []
      return {
        onRunSummary(s) {
          lines.push(
            JSON.stringify({ tasks: s.taskCount, failed: s.failedCount, cached: s.hitCount }),
          )
        },
        async flush() {
          if (lines.length > 0) await appendFile(to, lines.splice(0).join('\n') + '\n')
        },
      }
    },
  })
}
