import type {
  D1Database,
  DurableObjectNamespace,
  KVNamespace,
  Queue,
  R2Bucket,
} from '@cloudflare/workers-types'

export type Env = {
  DB: D1Database
  ARTIFACTS: R2Bucket
  TOKEN_CACHE: KVNamespace
  EVENT_INGEST: Queue<QueuedEvent>
  RUN_COORDINATOR: DurableObjectNamespace
  INFLIGHT_DEDUP: DurableObjectNamespace
  VX_PROTOCOL_VERSION: string
  VX_REMOTE_CACHE_SIGNATURE_KEY?: string
}

export type QueuedEvent = {
  orgId: string
  runId: string
  seq: number
  tsNs: string
  eventJson: string
}

export type AuthContext = {
  orgId: string
  tokenId: string
  role: 'admin' | 'member' | 'ci'
}

export type Variables = {
  auth: AuthContext
}
