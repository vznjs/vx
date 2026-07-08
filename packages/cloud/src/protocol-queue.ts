// The run-queue wire contract (cloud-data-model-2026-07 §7.3) — cloud-owned
// message families on the existing run WebSocket, exactly like `dist:*`
// lives in protocol-dist.ts: core's `protocol.ts` stays untouched. The
// submitting socket IS the stream — after `queue:start` the standard core
// `{ t:'event' }` / `{ t:'result' }` messages follow, so the entire existing
// event-consumption path (createWireRenderer, RunConsole) works unchanged
// per socket.

import type { RunRequest } from '@vzn/vx'

/** Version sentinel for the queue wire; bump on any shape change. */
export const QUEUE_PROTOCOL_VERSION = 1

export interface QueueSubmitMessage {
  t: 'queue:submit'
  v: number
  request: RunRequest
}

export interface QueueCancelMessage {
  t: 'queue:cancel'
  v: number
  jobId: string
}

/** client → serve. */
export type QueueClientMessage = QueueSubmitMessage | QueueCancelMessage

/** serve → client, on the submitting socket. */
export type QueueServerMessage =
  | { t: 'queue:accepted'; jobId: string; position: number } // 0 = starting now
  | { t: 'queue:update'; jobId: string; position: number } // earlier jobs finished
  | { t: 'queue:start'; jobId: string }
  | { t: 'queue:done'; jobId: string; runId?: string; ok: boolean } // runId → /runs/:id
  | { t: 'queue:refused'; message: string } // full queue / bad request
