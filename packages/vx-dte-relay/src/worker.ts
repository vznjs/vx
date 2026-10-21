// The relay on Cloudflare Workers: each run is one Durable Object, so one
// run's mailboxes live in one place and its held polls answer there.
// `wrangler.jsonc` deploys it; set ISSUERS and AUDIENCE.

import { createVerifier } from './oidc.js'
import { createRelay, type Relay } from './relay.js'

/** The parts of the Workers runtime this file uses, so it needs no types package. */
interface DurableObjectId {}
interface DurableObjectStub {
  fetch(req: Request): Promise<Response>
}
export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): DurableObjectStub
}

export interface Env {
  readonly RELAY: DurableObjectNamespace
  /** The issuers whose tokens the relay trusts, comma or space separated. */
  readonly ISSUERS: string
  /** The `aud` every token must name. */
  readonly AUDIENCE: string
}

const RUN = /^\/v1\/runs\/([^/]+)\//

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    const run = RUN.exec(new URL(req.url).pathname)?.[1]
    if (run === undefined) return Response.json({ error: 'no such route' }, { status: 404 })
    return env.RELAY.get(env.RELAY.idFromName(run)).fetch(req)
  },
}

/** One run's relay. */
export class RelayRun {
  private readonly relay: Relay

  constructor(_state: unknown, env: Env) {
    const issuers = env.ISSUERS.split(/[\s,]+/).filter((s) => s !== '')
    if (issuers.length === 0 || env.AUDIENCE === '')
      throw new Error('vx-dte-relay: set ISSUERS and AUDIENCE')
    this.relay = createRelay({ verify: createVerifier({ issuers, audience: env.AUDIENCE }) })
  }

  fetch(req: Request): Promise<Response> {
    return this.relay.fetch(req)
  }
}
