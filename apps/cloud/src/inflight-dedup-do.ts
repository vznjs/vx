import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.js'

// Content-addressed dedup: one DO per task hash (DO id = the hash).
// The first submitter for a hash becomes the OWNER; subsequent submitters
// become WAITERS that join the in-flight promise instead of re-running.
// The owner reports the outcome on completion; waiters receive it via
// /poll (long-poll) or future WS fan-out from the RunCoordinatorDO.

type ClaimResult =
  | { owner: true; workerId: string }
  | { owner: false; waitForResult: true; ownerWorkerId: string }

type Outcome = {
  status: 'success' | 'failed' | 'skipped' | 'aborted'
  hash: string
  reportedAt: number
}

type State = {
  ownerWorkerId: string | null
  outcome: Outcome | null
  claimedAt: number
}

const STATE_KEY = 'state'

export class InflightDedupDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/claim':
        return this.handleClaim(request)
      case '/report':
        return this.handleReport(request)
      case '/poll':
        return this.handlePoll()
      default:
        return new Response('not found', { status: 404 })
    }
  }

  private async handleClaim(request: Request): Promise<Response> {
    const { workerId } = (await request.json()) as { workerId: string }
    const state = await this.loadState()

    if (state.ownerWorkerId === null) {
      const next: State = { ownerWorkerId: workerId, outcome: null, claimedAt: Date.now() }
      await this.ctx.storage.put(STATE_KEY, next)
      const result: ClaimResult = { owner: true, workerId }
      return Response.json(result)
    }

    const result: ClaimResult = {
      owner: false,
      waitForResult: true,
      ownerWorkerId: state.ownerWorkerId,
    }
    return Response.json(result)
  }

  private async handleReport(request: Request): Promise<Response> {
    const outcome = (await request.json()) as Outcome
    const state = await this.loadState()
    const next: State = { ...state, outcome: { ...outcome, reportedAt: Date.now() } }
    await this.ctx.storage.put(STATE_KEY, next)
    // TODO: broadcast to waiters via the RunCoordinatorDO once wired.
    return Response.json({ ok: true })
  }

  private async handlePoll(): Promise<Response> {
    const state = await this.loadState()
    return Response.json({ outcome: state.outcome })
  }

  private async loadState(): Promise<State> {
    const stored = await this.ctx.storage.get<State>(STATE_KEY)
    return stored ?? { ownerWorkerId: null, outcome: null, claimedAt: 0 }
  }
}
