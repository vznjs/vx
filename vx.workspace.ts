import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { otel } from '@vzn/vx-otel'
import { cloud } from '@vzn/vx-cloud/plugin'

// Nothing runs that is not declared here — including core's own executor
// and cache. Order is precedence: cloud() (when configured) delegates the
// run or layers its remote cache ahead of the local one; otel() observes.
//
//   otel()   — export each run as OpenTelemetry traces + metrics. Activates
//              when OTEL_EXPORTER_OTLP_ENDPOINT is set.
//   cloud()  — push the run summary to a vx-cloud deployment's /v1/ingest
//              (VX_CLOUD_INGEST_URL), and optionally route the remote cache
//              (VX_REMOTE_CACHE_URL) / delegate execution (VX_SERVICE_URL).
//              vx-cloud is independent: it ingests these pushes into its own
//              store — it never reads this workspace's cache.db.
export default defineWorkspace({
  plugins: [otel(), cloud(), localExecutorPlugin(), localCachePlugin()],
})
