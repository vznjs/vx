// HTTP client for the synchronizer, shared by both ends.
//
// Shared deliberately: the plugin and the worker are the two halves of one
// protocol, and a client each would let them drift on a path or a field name
// with nothing to catch it until a run hung.

import type {
  Assignment,
  AssignmentResult,
  DispatchRequest,
  OpenRunResponse,
  RegisterWorkerRequest,
  RegisterWorkerResponse,
  RunEvent,
} from './protocol.js'

export class SyncError extends Error {}

export interface SyncClientOptions {
  readonly endpoint: string
  readonly authToken?: string
}

export class SyncClient {
  private readonly base: string

  constructor(private readonly opts: SyncClientOptions) {
    this.base = opts.endpoint.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.opts.authToken === undefined
        ? {}
        : { authorization: `Bearer ${this.opts.authToken}` }),
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      throw new SyncError(
        `@vzn/vx-agents: ${method} ${path} failed (${res.status}): ${await res.text()}`,
      )
    }
    return (await res.json()) as T
  }

  // ---------------------------------------------------------- the vx side

  async openRun(commit: string, remote: string): Promise<OpenRunResponse> {
    return await this.call<OpenRunResponse>('POST', '/v0/runs', { commit, remote })
  }

  async dispatch(runId: string, req: DispatchRequest): Promise<string> {
    const res = await this.call<{ assignmentId: string }>(
      'POST',
      `/v0/runs/${runId}/assignments`,
      req,
    )
    return res.assignmentId
  }

  async closeRun(runId: string): Promise<void> {
    await this.call('DELETE', `/v0/runs/${runId}`)
  }

  /**
   * Subscribe to a run's events. Resolves once the stream is open, so a caller
   * can dispatch knowing it will not miss the result of what it dispatches.
   */
  async subscribe(
    runId: string,
    onEvent: (event: RunEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${this.base}/v0/runs/${runId}/events`, {
      headers: this.headers(),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!res.ok || res.body === null) {
      throw new SyncError(`@vzn/vx-agents: could not subscribe to run ${runId} (${res.status})`)
    }
    void pump(res.body, onEvent)
  }

  // ------------------------------------------------------ the worker side

  async register(req: RegisterWorkerRequest): Promise<RegisterWorkerResponse> {
    return await this.call<RegisterWorkerResponse>('POST', '/v0/workers', req)
  }

  async heartbeat(workerId: string, commit?: string): Promise<void> {
    await this.call('POST', `/v0/workers/${workerId}/heartbeat`, { commit })
  }

  /** Long-poll for work. `null` means the poll expired with nothing to do. */
  async claim(workerId: string, signal?: AbortSignal): Promise<Assignment | null> {
    const res = await fetch(`${this.base}/v0/work?worker=${encodeURIComponent(workerId)}`, {
      headers: this.headers(),
      ...(signal === undefined ? {} : { signal }),
    })
    if (res.status === 204) return null
    if (!res.ok) {
      throw new SyncError(
        `@vzn/vx-agents: claiming work failed (${res.status}): ${await res.text()}`,
      )
    }
    return (await res.json()) as Assignment
  }

  async output(assignmentId: string, stream: 'out' | 'err', chunk: string): Promise<void> {
    await this.call('POST', `/v0/assignments/${assignmentId}/output`, { stream, chunk })
  }

  async result(assignmentId: string, result: AssignmentResult): Promise<void> {
    await this.call('POST', `/v0/assignments/${assignmentId}/result`, result)
  }
}

/** Read an SSE body, one `data:` line per event. */
async function pump(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: RunEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const frame = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (line !== undefined) onEvent(JSON.parse(line.slice(6)) as RunEvent)
        cut = buffer.indexOf('\n\n')
      }
    }
  } catch {
    // The stream ends when the run closes or the process goes away. Neither is
    // an error worth reporting from here — the caller already knows its run is
    // over, and a worker's death surfaces as a result event, not a torn stream.
  }
}
