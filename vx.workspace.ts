import { defineWorkspace } from '@vzn/vx'
import { localExecutorPlugin } from '@vzn/vx/plugins/local-executor'
import { localCachePlugin } from '@vzn/vx/plugins/local-cache'
import { otel } from '@vzn/vx-otel'

// Nothing runs that is not declared here — including core's own executor
// and cache. Order is precedence: a plugin listed earlier is consulted
// first, so a remote cache layer or executor placed before the local one
// wins.
//
//   otel()  — export each run as OpenTelemetry traces + metrics. Activates
//             when OTEL_EXPORTER_OTLP_ENDPOINT is set, declines otherwise.
export default defineWorkspace({
  plugins: [otel(), localExecutorPlugin(), localCachePlugin()],
})
