// The thread that writes a run's hits to the history while the run goes on
// (history-stream.ts). A connection of its own on the run's cache files,
// opened as `Cache` opens them; each batch is one IMMEDIATE transaction,
// answered by its sequence number so the run knows which landed.
// A separate entry point: `bun build --compile` embeds it beside bin.ts.

import { Database } from 'bun:sqlite'
import { type RunRecord, RunHistory } from './run-history.js'
import { SQLITE_FCNTL_PERSIST_WAL } from '../index-db/index.js'

export type HistoryWriterIn =
  | { open: { index: string; store?: string } }
  | { seq: number; hits: string }
  | { end: true }

export type HistoryWriterOut = { seq: number; error?: string } | { ended: true }

declare const self: Worker

let db: Database | undefined
let history: RunHistory | undefined
let refused: string | undefined

function open(files: { index: string; store?: string }): void {
  // The timeout first, as `Cache` sets it: every later pragma waits under it.
  db = new Database(files.index)
  db.exec('PRAGMA busy_timeout = 5000')
  db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 1)
  db.exec('PRAGMA journal_size_limit = 67108864')
  db.exec('PRAGMA synchronous = NORMAL')
  if (files.store !== undefined) {
    db.prepare('ATTACH DATABASE ? AS store').run(files.store)
    db.fileControl('store', SQLITE_FCNTL_PERSIST_WAL, 1)
    db.exec('PRAGMA store.journal_size_limit = 67108864')
    db.exec('PRAGMA store.synchronous = NORMAL')
  }
  // A streamed hit carries no forward args (history-stream.ts): nothing digests.
  history = new RunHistory(db, () => {
    throw new Error('a streamed hit has no value to digest')
  })
}

self.onmessage = (e: MessageEvent<HistoryWriterIn>) => {
  const m = e.data
  if ('open' in m) {
    try {
      open(m.open)
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err)
    }
    return
  }
  if ('end' in m) {
    try {
      db?.close()
    } catch {
      // The rows are in; a close that fails leaves the WAL to the next opener.
    }
    postMessage({ ended: true } satisfies HistoryWriterOut)
    return
  }
  if (history === undefined) {
    postMessage({ seq: m.seq, error: refused ?? 'not open' } satisfies HistoryWriterOut)
    return
  }
  try {
    history.recordHits(JSON.parse(m.hits) as RunRecord[])
    postMessage({ seq: m.seq } satisfies HistoryWriterOut)
  } catch (err) {
    postMessage({
      seq: m.seq,
      error: err instanceof Error ? err.message : String(err),
    } satisfies HistoryWriterOut)
  }
}
