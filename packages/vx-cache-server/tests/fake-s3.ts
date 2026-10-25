// An S3-compatible bucket in memory, path-style, enough for Bun's S3
// client: objects and multipart uploads. Signatures are not checked.

export interface FakeS3 {
  url: string
  objects: Map<string, Uint8Array>
  /** Each request, `METHOD /path?query`. */
  log: string[]
  stop(): Promise<void>
}

export function fakeS3(port = 0): FakeS3 {
  const objects = new Map<string, Uint8Array>()
  const uploads = new Map<string, Map<number, Uint8Array>>()
  const log: string[] = []
  let next = 0
  const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const name = decodeURIComponent(url.pathname)
      const q = url.searchParams
      log.push(`${req.method} ${url.pathname}${url.search}`)
      if (req.method === 'POST' && q.has('uploads')) {
        const id = String(++next)
        uploads.set(id, new Map())
        return xml(
          `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        )
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        uploads.get(q.get('uploadId')!)!.set(Number(q.get('partNumber')), await bytes(req))
        return new Response(null, { headers: { etag: `"${q.get('partNumber')}"` } })
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        const parts = [...uploads.get(q.get('uploadId')!)!].sort(([a], [b]) => a - b)
        objects.set(name, Buffer.concat(parts.map(([, b]) => b)))
        uploads.delete(q.get('uploadId')!)
        return xml(
          `<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>`,
        )
      }
      if (req.method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId')!)
        return new Response(null, { status: 204 })
      }
      if (req.method === 'PUT') {
        objects.set(name, await bytes(req))
        return new Response(null, { headers: { etag: '"x"' } })
      }
      if (req.method === 'DELETE') {
        objects.delete(name)
        return new Response(null, { status: 204 })
      }
      const held = objects.get(name)
      if (held === undefined) {
        return xml('<Error><Code>NoSuchKey</Code><Message>no such key</Message></Error>', 404)
      }
      return new Response(req.method === 'HEAD' ? null : held, {
        headers: { 'content-length': String(held.byteLength), etag: '"x"' },
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    objects,
    log,
    stop: () => server.stop(true),
  }
}

const bytes = async (req: Request): Promise<Uint8Array> => new Uint8Array(await req.arrayBuffer())

const xml = (body: string, status = 200): Response =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { 'content-type': 'application/xml' },
  })
