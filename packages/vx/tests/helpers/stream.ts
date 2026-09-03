/** A byte buffer as a stream of `chunk`-sized pieces — odd sizes keep tar block boundaries off the chunk boundaries. */
export function streamOf(bytes: Uint8Array, chunk = 700): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.byteLength; i += chunk) c.enqueue(bytes.subarray(i, i + chunk))
      c.close()
    },
  })
}
