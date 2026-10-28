// The conformance suite against the image `docker run` serves, started by
// smoke.sh: the container is held to what the Bun and Workers relays are
// (2026-10-25). Not `*.test.ts`: `bun test` alone has no container.
import { conformance } from '../conformance.js'

/** The container's URL; never a skip: smoke.sh always sets it. */
function base(): string {
  const url = process.env['VX_DTE_RELAY_SMOKE']
  if (url === undefined) throw new Error('smoke.sh runs this, against the container it starts')
  return url
}

conformance('the Docker relay', { base, headers: () => ({}) })
