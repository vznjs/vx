// A bucket in memory, for tests that need no S3.

import type { Blobs } from '../src/store.js'

export function memBlobs(held = new Map<string, Uint8Array>()): Blobs {
  return {
    async put(name, body, size) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer())
      if (bytes.byteLength !== size) throw new Error(`${bytes.byteLength} bytes, not ${size}`)
      held.set(name, bytes)
    },
    get: async (name) => {
      const b = held.get(name)
      return b === undefined ? null : { body: new Blob([b]).stream(), size: b.byteLength }
    },
    size: async (name) => held.get(name)?.byteLength ?? null,
  }
}
