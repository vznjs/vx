// A bad compression variable warned `compression "zstd" is not gzip or
// none`, naming none of the three variables it may have come from, and a
// second bad one (a signal's own) was not said at all. Each is named, once.
import { expect, it } from 'bun:test'
import { resolveOtelConfig } from '../src/plugin.js'

const warnings = (env: Record<string, string>): string[] => {
  const warns: string[] = []
  resolveOtelConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318', ...env }, (m) =>
    warns.push(m),
  )
  return warns
}

it('names the compression variable that is not gzip or none, once each', () => {
  expect(warnings({ OTEL_EXPORTER_OTLP_COMPRESSION: 'zstd' })).toEqual([
    '[vx] vx-otel: OTEL_EXPORTER_OTLP_COMPRESSION "zstd" is not gzip or none — sent uncompressed',
  ])
  expect(
    warnings({
      OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: 'zstd',
      OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: 'br',
    }),
  ).toEqual([
    '[vx] vx-otel: OTEL_EXPORTER_OTLP_TRACES_COMPRESSION "zstd" is not gzip or none — sent uncompressed',
    '[vx] vx-otel: OTEL_EXPORTER_OTLP_LOGS_COMPRESSION "br" is not gzip or none — sent uncompressed',
  ])
})
