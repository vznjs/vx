// zstd framing for artifacts: the declared-size gate that refuses a bomb before
// it expands, and the bounded one-call and streamed decoders.

import { CorruptArtifactError } from './layer.js'

/**
 * A decompressed artifact above this is refused as a bomb: far past any real
 * build output, it bounds what a hostile remote can make a hit allocate.
 * Lowered only by tests (`artifactCeiling`).
 */
export const MAX_DECOMPRESSED_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024

/**
 * A zstd frame's declared Frame_Content_Size (RFC 8878 §3.1.1), without
 * decompressing; null when omitted or unparsable. Exported so tests pin each
 * `fcsFlag` layout, which a bomb e2e cannot tell apart.
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
 * Whether `b` is exactly ONE zstd frame and not a byte after:
 * `Bun.zstdDecompress` decodes every frame, so a small frame with a bomb
 * appended passed the first frame's declared size. Anything else decodes as a
 * stream under the running count.
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
 * Decompress an artifact that DECLARES its size, refused before allocation when
 * the declaration is over the cap. A frame with no declaration never comes
 * here: `decodedTar` streams it under the running count.
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
  // Unreachable as written, kept deliberately: the declaration is checked
  // above, Bun refuses a body that disagrees with it, and only one whole frame
  // comes here. It fires only if a decoder stops validating the declaration.
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
 * At or below this many bytes the one-call codec and file I/O run on the
 * calling thread: a pool round trip cost more CPU than the work.
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
 * Bun's `CompressionStream` types do not satisfy `pipeThrough`; the runtime
 * object is a plain byte transform.
 */
export const zstdEncoder = (): TransformStream<Uint8Array, Uint8Array> =>
  new CompressionStream('zstd') as unknown as TransformStream<Uint8Array, Uint8Array>

/** Bytes in memory as a one-chunk stream, for a reader that takes a stream. */
const oneChunk = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })

/**
 * The decoded tar as a stream: one call for a small artifact that declares its
 * size, a streamed decode otherwise. Bytes in memory are only ever small (a
 * Blob would copy a large source). The 2 GiB ceiling applies either way.
 */
export async function decodedTar(
  source: Uint8Array | Bun.BunFile,
  hash: string,
  /**
   * The decompression ceiling: `Cache` passes its `artifactCeiling`, whose
   * default is this module's.
   */
  cap: number = MAX_DECOMPRESSED_ARTIFACT_BYTES,
): Promise<ReadableStream<Uint8Array>> {
  if (source instanceof Uint8Array) {
    if (assertDeclaredSize(source, hash, cap) === null || !isOneFrame(source)) {
      return zstdDecodeStream(new Blob([source]), hash, cap)
    }
    return oneChunk(await zstdDecompressBounded(source, hash, cap))
  }
  // A BunFile reads no further than the size its first stat cached, and a
  // re-save may rename a longer copy over the path after it. The size only
  // picks the decode; each read goes through a fresh handle.
  const fresh = (): Bun.BunFile => Bun.file(source.name!)
  if (source.size <= STREAM_DECODE_FROM) {
    const bytes = await fresh().bytes()
    if (assertDeclaredSize(bytes, hash, cap) === null || !isOneFrame(bytes)) {
      return zstdDecodeStream(new Blob([bytes]), hash, cap)
    }
    return oneChunk(await zstdDecompressBounded(bytes, hash, cap))
  }
  assertDeclaredSize(await fresh().slice(0, 32).bytes(), hash, cap)
  return zstdDecodeStream(fresh(), hash, cap)
}

/**
 * The streaming twin of `zstdDecompressBounded`: the count runs as bytes are
 * produced, so a bomb cannot expand past the cap.
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
