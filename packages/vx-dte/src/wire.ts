// A participant of the relay protocol (@vzn/vx-dte-relay's PROTOCOL.md).

export interface RelayMessage {
  readonly from: string
  readonly body: unknown
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface Participant {
  readonly id: string
  readonly heartbeatMs: number
  send(to: string, body: unknown): Promise<void>
  /** Held up to one heartbeat, which also keeps this participant alive. */
  poll(signal?: AbortSignal): Promise<RelayMessage[]>
  leave(): Promise<void>
}

export async function join(
  relay: string,
  run: string,
  role: 'orchestrator' | 'agent',
  info: unknown,
  token: string | undefined,
): Promise<Participant> {
  const base = `${relay.replace(/\/+$/, '')}/v1/runs/${encodeURIComponent(run)}/`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  const call = async (verb: string, body?: unknown, query = '', signal?: AbortSignal) => {
    const res = await fetch(base + verb + query, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (res.status === 204) return null
    const json = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok)
      throw new RelayError(res.status, `relay ${verb}: ${res.status} ${json.error ?? ''}`)
    return json as Record<string, unknown>
  }
  const joined = (await call('join', { role, info }))!
  const id = joined['id'] as string
  const heartbeatMs = joined['heartbeatMs'] as number
  return {
    id,
    heartbeatMs,
    async send(to, body) {
      await call('send', { id, to, body })
    },
    async poll(signal) {
      const r = await call('poll', undefined, `?id=${id}&wait=${heartbeatMs}`, signal)
      return (r?.['messages'] ?? []) as RelayMessage[]
    },
    async leave() {
      await call('leave', { id }).catch(() => undefined)
    },
  }
}
