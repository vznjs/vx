// The relay on Cloudflare Workers: each run is one Durable Object, so one
// run's mailboxes live in one place and its held polls answer there.
// `cloudflare.config.ts` deploys it; set REPOSITORIES.

import { claimedRun, createVerifier } from './oidc.js'
import { createRelay, runKey, type Relay } from './relay.js'

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
  /** The repositories whose runs it carries, `owner/repo`, comma or space separated. */
  readonly REPOSITORIES?: string
  /** The `aud` every token must name; unset, the URL the relay is reached at. */
  readonly AUDIENCE?: string
}

const list = (s: string | undefined): string[] => (s ?? '').split(/[\s,]+/).filter((v) => v !== '')

const RUN = /^\/v1\/runs\/([^/]+)\//

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    const run = RUN.exec(new URL(req.url).pathname)?.[1]
    if (run === undefined) return Response.json({ error: 'no such route' }, { status: 404 })
    const token = /^Bearer (\S+)$/.exec(req.headers.get('authorization') ?? '')?.[1]
    const claimed = token === undefined ? undefined : claimedRun(token)
    return env.RELAY.get(env.RELAY.idFromName(runKey(run, claimed))).fetch(req)
  },
}

/** One run's relay. */
export class RelayRun {
  private readonly relay: Relay

  constructor(_state: unknown, env: Env) {
    const issuers = list(env.ISSUERS)
    const repositories = list(env.REPOSITORIES)
    if (issuers.length === 0 || repositories.length === 0)
      throw new Error('vx-dte-relay: set ISSUERS and REPOSITORIES')
    // The worker's URL is not known before its first deploy; a token for
    // another one is not meant for this relay.
    const verifiers = new Map<string, ReturnType<typeof createVerifier>>()
    const verifierOf = (audience: string): ReturnType<typeof createVerifier> => {
      let v = verifiers.get(audience)
      if (v === undefined) {
        v = createVerifier({ issuers, audience, repositories })
        verifiers.set(audience, v)
      }
      return v
    }
    this.relay = createRelay({
      verify: (token, req) => verifierOf(env.AUDIENCE || new URL(req.url).origin)(token),
    })
  }

  fetch(req: Request): Promise<Response> {
    return this.relay.fetch(req)
  }
}
