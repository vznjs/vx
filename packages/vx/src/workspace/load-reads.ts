// A load reads each root file once. Finding the root reads its manifest,
// listing the package globs read it again and the workspace fingerprint a
// third time. Every such read goes through a `LoadReads` the load owns, so
// a file costs one probe and one read per load however many stages ask for
// it. The map lives exactly as long as the load: a `vx watch` cycle is a
// new load and reads fresh bytes.

/** The files one load has read, by absolute path: the bytes, or null when no file is there. */
export type LoadReads = Map<string, Promise<Uint8Array | null>>

/**
 * `file`'s bytes, read at most once per `reads`; null when there is no file
 * there (`Bun.file(<dir>).exists()` is false, so a directory is none).
 *
 * The probe stays ahead of the read: most names asked about are absent (six
 * of the seven fingerprint files, three of the four workspace config names),
 * and a failed read costs 90–200 µs building its error where `exists()`
 * answers in 15–40 µs (measured 2026-09-24) — so one stat per present file
 * is cheaper than letting the open answer both questions.
 */
export function readOnce(reads: LoadReads | undefined, file: string): Promise<Uint8Array | null> {
  const held = reads?.get(file)
  if (held !== undefined) return held
  const pending = readIfFile(file)
  reads?.set(file, pending)
  return pending
}

async function readIfFile(file: string): Promise<Uint8Array | null> {
  const f = Bun.file(file)
  return (await f.exists()) ? await f.bytes() : null
}
