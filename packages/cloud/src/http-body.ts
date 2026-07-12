// Shared request-body reader with a HARD streaming cap. The platform's single
// Bun.serve sets `maxRequestBodySize` to just past the 512 MiB artifact-PUT
// limit, so any endpoint with a SMALLER cap (ingest, logs, catalog, MCP, the
// cache batch probe) must stream + abort mid-body — checking the size AFTER
// `req.text()` is too late, because a chunked (no-content-length) body has
// already been fully buffered by then.

/**
 * Read a request body as text, aborting once cumulative bytes exceed `max`
 * (returns null → the caller answers 413). Streams via the body reader so a
 * lying or absent content-length can't defeat the cap. Falls back to `text()`
 * only when the body isn't a stream (a bodyless request).
 */
export async function readTextBounded(req: Request, max: number): Promise<string | null> {
  const reader = req.body?.getReader()
  if (reader === undefined) {
    const t = await req.text()
    return Buffer.byteLength(t, 'utf8') > max ? null : t
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
