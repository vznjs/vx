// `POST /v1/artifacts/upload`'s body: a JSON line naming each artifact,
// then their bytes in that order.

import { BATCH_TYPE } from '../src/protocol.js'

export function upload(
  items: readonly (readonly [string, Blob | Uint8Array | string])[],
  token: string,
): RequestInit & { method: string; headers: Record<string, string> } {
  const blobs = items.map(([, b]) => new Blob([b]))
  const line = `${JSON.stringify({
    artifacts: items.map(([hash], i) => ({ hash, size: blobs[i]!.size })),
  })}\n`
  const body = new Blob([line, ...blobs])
  return {
    method: 'POST',
    body,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': BATCH_TYPE,
      'content-length': String(body.size),
    },
  }
}
