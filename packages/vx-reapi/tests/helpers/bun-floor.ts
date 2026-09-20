// The plugin's own runtime floor, as a test gate.
//
// `ReapiClient` refuses to construct on Bun < 1.4.0 (`assertBunSupportsChunking`):
// older Bun hangs on the chunked uploads this plugin makes, and a hang gives a
// user nothing to act on, so the version check speaks instead. Every row that
// builds a client therefore CANNOT run below that floor — and failing them
// there reports a broken plugin when what it has is an unusable runtime.
//
// Same shape as core's sandbox gate, and for the same reason: skip on a host
// that cannot host the thing, and let the flag CI sets turn a skip into a
// failure, because a skip is a silent pass. `VX_REQUIRE_REAPI=1` already means
// "this machine must really exercise the plugin" for the live suites; it means
// the same here.
import { assertBunSupportsChunking } from '../../src/wire.js'

const required = Bun.env['VX_REQUIRE_REAPI'] === '1'

export const CHUNKING_SUPPORTED: boolean = (() => {
  try {
    assertBunSupportsChunking()
    return true
  } catch (err) {
    if (required) throw err
    // eslint-disable-next-line no-console
    console.warn(
      `[reapi] skipping the rows that build a client — ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
})()
