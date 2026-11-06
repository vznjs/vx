// The index's WAL checkpoints, on a thread of their own while a run saves.
// SQLite checkpoints on the committing connection once the WAL passes 1,000
// pages: on a cold run that was the main thread, the scheduler's, copying
// pages and waiting on two fsyncs a checkpoint, stalls of up to 750 ms in
// a cold 8,002-task run (2026-11-06). Here a second connection checkpoints
// PASSIVE on a timer: it never waits on a lock and never blocks the writer,
// which appends as before; the run's connection checkpoints nothing until
// its close, which finds the WAL nearly copied.

import { SQLITE_FCNTL_PERSIST_WAL } from './schema.js'

/** How often the thread checkpoints: about 1,000 pages of a cold run's writes. */
const EVERY_MS = 100

// The thread as source, not a file: a compiled vx carries only its entry
// points' graphs (spawn-off.ts does the same).
const WORKER = `
const { Database } = require('bun:sqlite')
let db
let timer
const schemas = []
const tick = () => {
  for (const s of schemas) {
    try {
      db.exec('PRAGMA ' + s + '.wal_checkpoint(PASSIVE)')
    } catch {
      // Busy or gone: the next tick, or the run's close, copies it.
    }
  }
}
self.onmessage = (e) => {
  const m = e.data
  if (m.open !== undefined) {
    db = new Database(m.open.index)
    // As Cache opens it: a close here must not delete the WAL (O-10).
    db.fileControl(${SQLITE_FCNTL_PERSIST_WAL}, 1)
    schemas.push('main')
    if (m.open.store !== undefined) {
      // Finalized: a statement still alive left the close a zombie
      // connection, and a write right after the run was SQLITE_BUSY
      // (shared-store.test.ts).
      const attach = db.prepare('ATTACH DATABASE ? AS store')
      attach.run(m.open.store)
      attach.finalize()
      db.fileControl('store', ${SQLITE_FCNTL_PERSIST_WAL}, 1)
      schemas.push('store')
    }
    timer = setInterval(tick, m.everyMs)
    return
  }
  clearInterval(timer)
  try {
    db?.close()
  } catch {
    // The run's own close copies what is left.
  }
  postMessage({ ended: true })
}
`

export class WalCheckpointer {
  private readonly worker: Worker
  private failed = false
  private ended: (() => void) | undefined

  /** Starts checkpointing `files` every `everyMs`; `onError` hears a thread that could not. */
  constructor(
    files: { index: string; store?: string },
    onError: () => void,
    everyMs: number = EVERY_MS,
  ) {
    const w = new Worker(URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' })))
    // A run that throws before `stop` must still exit.
    w.unref()
    w.onmessage = () => this.ended?.()
    w.onerror = (e) => {
      e.preventDefault()
      this.failed = true
      this.ended?.()
      onError()
    }
    w.postMessage({ open: files, everyMs })
    this.worker = w
  }

  /** Stops the timer and closes the thread's connection, so the run's close is the last. */
  async stop(): Promise<void> {
    if (!this.failed) {
      this.worker.ref()
      await new Promise<void>((resolve) => {
        this.ended = resolve
        this.worker.postMessage({ end: true })
      })
    }
    this.worker.terminate()
  }

  /** A close that could not wait for `stop`: the thread ends where it is. */
  terminate(): void {
    this.worker.terminate()
  }
}
