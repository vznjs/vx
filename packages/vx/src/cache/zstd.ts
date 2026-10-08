// zstd framing for artifacts: the declared-size gate that refuses a
// decompression bomb before it can expand, and the bounded one-call /
// streamed decoders the store and the ingest path share.

import type { FileHandle } from 'node:fs/promises'
import { CorruptArtifactError } from './layer.js'

/**
 * A decompressed artifact above this is refused as a zstd bomb rather than
 * expanded into memory. 2 GiB comfortably exceeds any real build output while
 * bounding a malicious/compromised remote's ability to OOM a victim who takes
 * a cache hit. The default of `Cache`'s `artifactCeiling`, the one seam that
 * lowers it (for a test: no test can produce 2 GiB of output).
 */
export const MAX_DECOMPRESSED_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Read a zstd frame's declared Frame_Content_Size (RFC 8878 §3.1.1) WITHOUT
 * decompressing. Returns null when the frame omits it (streaming frames) or
 * the header is too short to parse. vx's own producer (single-shot
 * `Bun.zstdCompress` of a known buffer) always writes it, so an artifact that
 * declares an enormous size can be rejected before a byte is allocated.
 *
 * Exported for tests: pins the per-`fcsFlag` byte layouts (incl. the 2-byte
 * `+256` adjustment and the `dictIdFlag` offset) that a bomb-refusal e2e can't
 * discriminate (their max declarable sizes sit below the ceiling).
 */
export function zstdContentSize(b: Uint8Array): bigint | null {
  if (b.length < 5) return null
  // Magic_Number 0xFD2FB528, little-endian.
  if (b[0] !== 0x28 || b[1] !== 0xb5 || b[2] !== 0x2f || b[3] !== 0xfd) return null
  const desc = b[4]!
  const fcsFlag = desc >> 6
  const singleSegment = (desc >> 5) & 1
  const dictIdFlag = desc & 3
  let off = 5
  if (singleSegment === 0) off += 1 // Window_Descriptor byte
  off += dictIdFlag === 3 ? 4 : dictIdFlag // Dictionary_ID: 0,1,2,4 bytes
  let fcsSize: number
  if (fcsFlag === 0) fcsSize = singleSegment === 1 ? 1 : 0
  else if (fcsFlag === 1) fcsSize = 2
  else if (fcsFlag === 2) fcsSize = 4
  else fcsSize = 8
  if (fcsSize === 0 || b.length < off + fcsSize) return null
  let v = 0n
  for (let i = 0; i < fcsSize; i++) v |= BigInt(b[off + i]!) << BigInt(8 * i)
  if (fcsSize === 2) v += 256n // per spec, the 2-byte field stores value − 256
  return v
}

/**
 * Whether `b` is exactly ONE zstd frame: its header, its blocks by their
 * own sizes (RFC 8878 §3.1.1.2), the checksum when the header asks for one,
 * and not a byte after. `zstdContentSize` reads the first frame alone, and
 * `Bun.zstdDecompress` decodes every frame there is: a 100-byte frame with a
 * second one appended passed a 64 MiB ceiling and expanded to 2 GiB of
 * memory from a 32 KB remote body before the result's length was checked
 * (A-5). Anything but one whole frame decodes as a stream, under the running
 * count. A few header reads per block, on bytes already in memory.
 */
function isOneFrame(b: Uint8Array): boolean {
  if (b.length < 6) return false
  const desc = b[4]!
  const fcsFlag = desc >> 6
  const singleSegment = (desc >> 5) & 1
  const checksum = (desc >> 2) & 1
  const dictIdFlag = desc & 3
  let off = 5 + (singleSegment === 0 ? 1 : 0) + (dictIdFlag === 3 ? 4 : dictIdFlag)
  off += fcsFlag === 0 ? singleSegment : 1 << fcsFlag
  for (;;) {
    if (off + 3 > b.length) return false
    const h = b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16)
    const type = (h >> 1) & 3
    if (type === 3) return false
    off += 3 + (type === 1 ? 1 : h >>> 3)
    if ((h & 1) === 1) break
  }
  return off + (checksum === 1 ? 4 : 0) === b.length
}

/**
 * Decompress a zstd artifact that DECLARES its content size, with a hard
 * output ceiling: refused before a byte is allocated when the declaration
 * is over the cap. The re-check on the actual length below is a backstop
 * against a decoder that stops validating the declaration, NOT a second
 * live layer — see its comment. A frame with no
 * declaration (a streamed producer's — vx's own, above 4 MiB) never comes
 * here: `decodedTar` decodes it as a stream under the running count, so
 * a sizeless bomb has nowhere to expand.
 */
async function zstdDecompressBounded(
  compressed: Uint8Array,
  hash: string,
  cap: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
): Promise<Uint8Array> {
  const declared = assertDeclaredSize(compressed, hash, cap)
  const out =
    declared !== null && declared <= BigInt(ON_THREAD_MAX)
      ? Bun.zstdDecompressSync(compressed)
      : await Bun.zstdDecompress(compressed)
  // UNREACHABLE as written, and kept deliberately. `assertDeclaredSize`
  // above refuses any frame DECLARING more than the cap, Bun refuses a
  // frame whose declaration disagrees with its body ("Decompression
  // failed" on a forged Frame_Content_Size, measured item 487), and only
  // ONE whole frame comes here (`isOneFrame`) — so what gets here declared
  // <= cap and produced exactly that. Before A-5 a second frame appended
  // after the first reached it, past the whole expansion. The only way it
  // fires again is a decoder that stops validating the declaration.
  if (out.length > cap) {
    throw new CorruptArtifactError(hash, `decompressed to ${out.length} bytes (> ${cap} cap)`)
  }
  return out
}

/** The pre-decompress half of the ceiling: the frame header's own claim, when it makes one. */
function assertDeclaredSize(
  compressed: Uint8Array,
  hash: string,
  cap: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
): bigint | null {
  const declared = zstdContentSize(compressed)
  if (declared !== null && declared > BigInt(cap)) {
    throw new CorruptArtifactError(hash, `declares ${declared} decompressed bytes (> ${cap} cap)`)
  }
  return declared
}

/**
 * At or below this many bytes an artifact's one-call codec and file I/O
 * run on the calling thread. Each async call is a thread-pool round trip
 * (a futex wake, an eventfd write, an epoll turn) that cost more CPU than
 * the work itself for a one-file artifact, several times per save and
 * per restore.
 */
export const ON_THREAD_MAX = 256 * 1024

/** `Bun.zstdCompress`, on this thread when the input is small (`ON_THREAD_MAX`). */
export async function zstdCompress(bytes: Uint8Array): Promise<Uint8Array> {
  return bytes.byteLength <= ON_THREAD_MAX
    ? Bun.zstdCompressSync(bytes)
    : await Bun.zstdCompress(bytes)
}

/** Compressed artifacts above this size are decoded as a stream, on restore and on ingest. */
export const STREAM_DECODE_FROM = 4 * 1024 * 1024

/** Collect a byte stream; only ever used where the seam wants bytes. */
export async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Bun's `CompressionStream` types do not satisfy `pipeThrough`'s pair
 * (its readable side is typed `NonSharedUint8Array`); the runtime object
 * is a plain byte transform.
 */
export const zstdEncoder = (): TransformStream<Uint8Array, Uint8Array> =>
  new CompressionStream('zstd') as unknown as TransformStream<Uint8Array, Uint8Array>

/** Bytes in memory as a one-chunk stream, for a reader that takes a stream. */
export const oneChunk = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

/**
 * The decoded tar as a stream: one call for a small artifact that
 * declares its size, a streamed decode otherwise — the stream setup is
 * ~35 µs, which matters at a thousand one-file artifacts and nowhere
 * else. Bytes in memory are only ever the small case (a large source
 * must be a FILE: a Blob copies its bytes and hands the decoder
 * everything at once, measured +519 MiB on 150 MiB against +448 for the
 * plain decode). The 2 GiB ceiling applies either way: the declaration
 * and the result length in one call, a running count on the stream.
 */
export async function decodedTar(
  /** A handle reads one file, whatever replaces its name (cache.ts's restore). */
  source: Uint8Array | Bun.BunFile | FileHandle,
  hash: string,
  /**
   * The decompression ceiling: `Cache` passes its `artifactCeiling`, whose
   * default IS this module's. Reaching the real one needs an artifact that
   * expands past 2 GiB, which no test can produce — so before item 487 the
   * sizeless-bomb defense this module's comments promise had nothing
   * asserting it, while the declared-size half was pinned by a forged
   * header costing 20 bytes.
   */
  cap: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
): Promise<ReadableStream<Uint8Array>> {
  if (source instanceof Uint8Array) {
    if (assertDeclaredSize(source, hash, cap) === null || !isOneFrame(source)) {
      return zstdDecodeStream(new Blob([source]), hash, cap)
    }
    return oneChunk(await zstdDecompressBounded(source, hash, cap))
  }
  if (!(source instanceof Blob)) {
    const head = new Uint8Array(32)
    const { bytesRead } = await source.read(head, 0, head.length, 0)
    assertDeclaredSize(head.subarray(0, bytesRead), hash, cap)
    // Bun's file stream over the handle's descriptor: the handle's own web
    // stream reads 16 KiB at a time, 10x slower on 60 MiB.
    return zstdDecodeStream(Bun.file(source.fd), hash, cap)
  }
  if (source.size <= STREAM_DECODE_FROM) {
    const bytes = await source.bytes()
    if (assertDeclaredSize(bytes, hash, cap) === null || !isOneFrame(bytes)) {
      return zstdDecodeStream(source, hash, cap)
    }
    return oneChunk(await zstdDecompressBounded(bytes, hash, cap))
  }
  assertDeclaredSize(await source.slice(0, 32).bytes(), hash, cap)
  return zstdDecodeStream(source, hash, cap)
}

/**
 * The streaming twin of `zstdDecompressBounded`: the decoded bytes as a
 * stream, refused past the same ceiling. A malicious frame cannot expand
 * past the cap here either — the count runs as bytes are produced, before
 * any of them reach the reader's next entry.
 */
function zstdDecodeStream(
  source: Blob,
  hash: string,
  cap: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
): ReadableStream<Uint8Array> {
  let total = 0
  return source
    .stream()
    .pipeThrough(new DecompressionStream('zstd'))
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength
          if (total > cap) {
            controller.error(new CorruptArtifactError(hash, `decompresses past ${cap} bytes (cap)`))
            return
          }
          controller.enqueue(chunk)
        },
      }),
    )
}
