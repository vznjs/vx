/**
 * Turbo's outage breaker (`turborepo-cache/src/outage_breaker.rs`): three
 * outages in a row — no connection, no answer in time, or a 5xx once the
 * retries are spent — open it for 30 s, and while open no request is sent.
 * After the cooldown one request probes; its success closes the breaker,
 * its outage opens it again. Without it a server that hung cost every
 * task its full deadline. A result that lands after the breaker moved on
 * (a request already in flight when it opened) changes nothing. Shared by
 * `turboCache()` and `nxCache()`.
 *
 * A hit's body (`settleOnBody`, a 200 with a body) is judged when the
 * body ends, not when its headers land: a server that sent headers in
 * time and then stalled the body was judged a success, reset the count,
 * and cost every task its full deadline. The body's error is the outage;
 * its end or a cancel is the success. A body nobody reads or cancels
 * leaves its verdict open.
 */
export class OutageBreaker {
  private failures = 0
  private openUntil: number | undefined
  private probing = false
  private generation = 0
  constructor(private readonly now: () => number = Date.now) {}

  async send(request: () => Promise<Response>, settleOnBody = false): Promise<Response> {
    let probe = false
    if (this.openUntil !== undefined) {
      if (this.now() < this.openUntil || this.probing)
        throw new Error(
          `unavailable after ${FAILURE_THRESHOLD} failures in a row; not asked again for ${COOLDOWN_MS / 1000} s`,
        )
      this.probing = probe = true
    }
    const generation = this.generation
    let res: Response
    try {
      res = await request()
    } catch (err) {
      this.finish(generation, probe, true)
      throw err
    }
    if (!settleOnBody || res.status !== 200 || res.body === null) {
      this.finish(generation, probe, res.status >= 500)
      return res
    }
    const reader = res.body.getReader()
    const settle = (outage: boolean) => this.finish(generation, probe, outage)
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read().catch((err: unknown) => {
            settle(true)
            controller.error(err)
          })
          if (chunk === undefined) return
          if (chunk.done) {
            settle(false)
            controller.close()
          } else controller.enqueue(chunk.value)
        },
        async cancel(reason) {
          settle(false)
          await reader.cancel(reason)
        },
      }),
      { status: res.status, statusText: res.statusText, headers: res.headers },
    )
  }

  private finish(generation: number, probe: boolean, outage: boolean): void {
    if (generation !== this.generation) return
    if (outage) {
      this.failures++
      if (probe || this.failures >= FAILURE_THRESHOLD) {
        this.openUntil = this.now() + COOLDOWN_MS
        this.probing = false
        this.generation++
      }
      return
    }
    this.failures = 0
    if (probe) {
      this.openUntil = undefined
      this.probing = false
      this.generation++
    }
  }
}

const FAILURE_THRESHOLD = 3
const COOLDOWN_MS = 30_000
