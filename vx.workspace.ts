import { defineWorkspace } from '@vzn/vx'
import { otel } from '@vzn/vx-otel'
import { github } from '@vzn/vx-github'
import { mcp } from '@vzn/vx-mcp'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'

// Nothing runs that is not declared here — including core's own executor
// and cache. Order is precedence: a plugin listed earlier is consulted
// first, so a remote cache layer or executor placed before the local one
// wins.
//
//   otel()   — export each run as OpenTelemetry traces + metrics. Activates
//              when OTEL_EXPORTER_OTLP_ENDPOINT is set, declines otherwise.
//   github() — write each run as a GitHub Actions job summary. Activates on
//              GITHUB_STEP_SUMMARY, declines everywhere else. We dogfood our
//              own plugins so their decline paths run on every laptop run.
//   mcp()    — adds `vx mcp`, the read-only MCP server AI agents talk to.
//   scheduleHistoryPlugin() — orders ready tasks by the critical path this
//              workspace's own history recorded. `assume` covers the run
//              with no history, a fresh CI runner: the docs build is a
//              30 s leaf that the structural order starts LAST (it
//              unblocks one task), and on 2026-09-10 it was the 29 s tail
//              of a 99 s gate whose deps were done by the second second.
export default defineWorkspace({
  plugins: [
    otel(),
    github(),
    mcp(),
    scheduleHistoryPlugin({ assume: { '@vzn/vx-docs#build': 30_000 } }),
  ],
})
