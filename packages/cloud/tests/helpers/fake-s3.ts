// A minimal in-memory S3-compatible server for tests: PUT/HEAD/GET objects +
// ListObjectsV2, path-style (`/<bucket>/<key>`). Signatures are NOT verified
// (SigV4 correctness is pinned by blob-sigv4.test.ts against the AWS docs
// vectors) — but every presigned request (query carries `X-Amz-Signature`)
// records a violation if it arrives WITH credentials: a real query-signed URL
// rejects a doubled Authorization, and the serve-facing `x-vx-cache-scope`
// identity has no business reaching a blob origin. Tests assert
// `violations` stays empty, pinning the client's cross-origin drop through a
// real request flow.

export interface FakeS3Object {
  body: Uint8Array
  /** `x-amz-meta-*` request headers captured at PUT, lowercased names. */
  meta: Record<string, string>
  lastModified: Date
}

export interface FakeS3 {
  origin: string
  bucket: string
  /** Object key (bucket-relative) → stored object. Mutable — tests tamper. */
  objects: Map<string, FakeS3Object>
  requests: { method: string; path: string; presigned: boolean }[]
  /** Credentialed presigned requests — must stay empty. */
  violations: string[]
  stop(): void
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function startFakeS3(opts?: { bucket?: string; listPageSize?: number }): FakeS3 {
  const bucket = opts?.bucket ?? 'vx-test'
  const listPageSize = opts?.listPageSize ?? 1000
  const objects = new Map<string, FakeS3Object>()
  const requests: FakeS3['requests'] = []
  const violations: string[] = []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const presigned = url.searchParams.has('X-Amz-Signature')
      requests.push({ method: req.method, path: url.pathname, presigned })
      if (presigned) {
        if (req.headers.get('authorization') !== null) {
          violations.push(`authorization header on presigned ${url.pathname}`)
        }
        if (req.headers.get('x-vx-cache-scope') !== null) {
          violations.push(`x-vx-cache-scope header on presigned ${url.pathname}`)
        }
      }
      const m = /^\/([^/]+)\/(.*)$/.exec(url.pathname)
      if (m === null || decodeURIComponent(m[1]!) !== bucket) {
        return new Response('NoSuchBucket', { status: 404 })
      }
      const key = m[2]!.split('/').map(decodeURIComponent).join('/')

      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const token = url.searchParams.get('continuation-token')
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        const start = token !== null ? Number(token) : 0
        const page = keys.slice(start, start + listPageSize)
        const truncated = start + page.length < keys.length
        const contents = page
          .map((k) => {
            const o = objects.get(k)!
            return `<Contents><Key>${xmlEscape(k)}</Key><Size>${o.body.byteLength}</Size><LastModified>${o.lastModified.toISOString()}</LastModified></Contents>`
          })
          .join('')
        const next = truncated
          ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>`
          : ''
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`,
          { headers: { 'content-type': 'application/xml' } },
        )
      }

      if (req.method === 'PUT') {
        const body = new Uint8Array(await req.arrayBuffer())
        const meta: Record<string, string> = {}
        req.headers.forEach((v, k) => {
          if (k.startsWith('x-amz-meta-')) meta[k] = v
        })
        objects.set(key, { body, meta, lastModified: new Date() })
        return new Response(null, { status: 200 })
      }

      if (req.method === 'DELETE') {
        // S3 answers 204 whether or not the key existed — delete is idempotent.
        objects.delete(key)
        return new Response(null, { status: 204 })
      }

      const obj = objects.get(key)
      if (req.method === 'HEAD') {
        if (obj === undefined) return new Response(null, { status: 404 })
        return new Response(null, {
          status: 200,
          headers: {
            'content-length': String(obj.body.byteLength),
            'last-modified': obj.lastModified.toUTCString(),
            ...obj.meta,
          },
        })
      }
      if (req.method === 'GET') {
        if (obj === undefined) return new Response('NoSuchKey', { status: 404 })
        return new Response(obj.body, {
          headers: { 'last-modified': obj.lastModified.toUTCString(), ...obj.meta },
        })
      }
      return new Response(null, { status: 405 })
    },
  })

  return {
    origin: `http://localhost:${server.port}`,
    bucket,
    objects,
    requests,
    violations,
    stop: () => void server.stop(true),
  }
}
