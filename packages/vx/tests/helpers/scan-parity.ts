// Both artifact scanners over one tar: `scanArtifact` (the stream, what a
// restore and an ingest read) and `scanTarBytes` (in memory, what a save
// reads of its own tar). They must agree on every byte: the same result,
// or the same refusal, class and message.
import { expect } from 'bun:test'
import { scanArtifact, scanTarBytes } from '../../src/cache/archive.js'
import { streamOf } from './stream.js'

type Scan = Awaited<ReturnType<typeof scanArtifact>>
export type ScanOutcome = { ok: Scan } | { refused: string; message: string; error: unknown }

const refusal = (error: unknown): ScanOutcome => ({
  refused: error instanceof Error ? error.constructor.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
  error,
})

const shown = (o: ScanOutcome) => ('ok' in o ? o : { refused: o.refused, message: o.message })

/** The stream scan's outcome, after asserting the in-memory scan's is the same. */
export async function scanBoth(tar: Uint8Array, chunk = 700): Promise<ScanOutcome> {
  const stream = await scanArtifact(streamOf(tar, chunk)).then(
    (ok): ScanOutcome => ({ ok }),
    refusal,
  )
  let sync: ScanOutcome
  try {
    sync = { ok: scanTarBytes(tar) }
  } catch (err) {
    sync = refusal(err)
  }
  expect(shown(sync)).toStrictEqual(shown(stream))
  return stream
}

/** `scanBoth`, resolving to the scan or rejecting with the stream scan's own error. */
export async function scanBothOrThrow(tar: Uint8Array, chunk?: number): Promise<Scan> {
  const o = await scanBoth(tar, chunk)
  if ('ok' in o) return o.ok
  throw o.error
}
