import { defineWorkspace } from '@vzn/vx'
import { otel } from '@vzn/vx-otel'
import { cloud } from '@vzn/vx-cloud/plugin'

// vx is a CORE that never changes its own behavior; every external integration
// is an opt-in plugin declared here. Both plugins are observe/route-only and
// DECLINE when unconfigured, so this is zero-overhead by default:
//
//   otel()   — export each run as OpenTelemetry traces + metrics. Activates
//              when OTEL_EXPORTER_OTLP_ENDPOINT is set.
//   cloud()  — push the run summary to a vx-cloud deployment's /v1/ingest
//              (VX_CLOUD_INGEST_URL), and optionally route the remote cache
//              (VX_REMOTE_CACHE_URL) / delegate execution (VX_SERVICE_URL).
//              vx-cloud is independent: it ingests these pushes into its own
//              store — it never reads this workspace's cache.db.
export default defineWorkspace({
  plugins: [otel(), cloud()],
})
