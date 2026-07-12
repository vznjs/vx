# `src/orchestrator/protocol.ts` + `wire.ts` — run wire contract

## Purpose

The transport-agnostic contract for delegating a run: `RunRequest` /
`RunResult` plus the `ServerMessage` / `ClientMessage` envelope, and the
`RunOptions ⇄ RunRequest` mappers. The service package's server/backend
speak exactly this; the service-only distribution messages (`worker:*` /
`coord:*`) live in that package's `protocol-dist.ts`.

## Invariants

- Everything crossing the wire is JSON-safe (WireEvent projection; no
  bigints, no node back-refs).
- Mappers are total: every `RunOptions` field either maps or is
  documented as local-only.
