// Hand-rolled AWS Signature V4 — header-signed requests (serve → bucket:
// PUT/HEAD/LIST) and query-signed presigned GET URLs (handed to the client).
// No AWS SDK: the blob backend needs exactly four request shapes and the
// SDK's dependency closure is enormous (docs/design/s3-blob-backend-2026-07.md).
// Pinned by the AWS documentation's published test vectors in
// tests/blob-sigv4.test.ts.

import { createHash, createHmac } from 'node:crypto'

/** The SigV4 payload-hash sentinel for unhashed streaming bodies (TLS-only
 *  transport integrity — the artifact's own integrity story is the
 *  client-side `x-vx-digest`). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

export interface SignRequestArgs {
  method: string
  url: URL
  /** Extra headers to sign (`x-amz-meta-*`, `range`, …). AWS requires every
   *  `x-amz-*` header on the wire to be signed. */
  headers?: Record<string, string>
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  /** Hex SHA-256 of the payload; defaults to UNSIGNED-PAYLOAD. */
  payloadSha256?: string
  /** Signing time — injectable so tests are deterministic. */
  date?: Date
}

export interface PresignUrlArgs {
  method: string
  url: URL
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  expiresSeconds: number
  /** Signing time — injectable so tests are deterministic. */
  date?: Date
}

/**
 * AWS URI encoding: everything except unreserved `A-Za-z0-9-._~` is
 * percent-encoded with uppercase hex. Callers preserve `/` in URI paths by
 * encoding per segment; in query values `/` IS encoded.
 */
export function awsUriEncode(s: string): string {
  // encodeURIComponent leaves !*'() unencoded; AWS's unreserved set doesn't.
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

// Re-canonicalize each path segment (decode, then AWS-encode) so a
// caller-built path and its canonical form can never drift; `/` separators
// survive. S3 single-encodes the canonical URI (unlike every other service).
function canonicalUri(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => awsUriEncode(decodeURIComponent(seg)))
    .join('/')
}

// Params sorted by encoded name (then value), each side AWS-encoded. The
// SAME string is used on the wire for presigned URLs, so wire == canonical
// by construction.
function canonicalQuery(params: Iterable<readonly [string, string]>): string {
  return [...params]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

/** `20130524T000000Z` */
function amzDate(d: Date): string {
  return d.toISOString().replace(/[-:]|\.\d{3}/g, '')
}

const sha256hex = (data: string): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest()

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request')
}

function signature(
  args: { secretAccessKey: string; region: string },
  service: string,
  stamp: string,
  scope: string,
  canonicalRequest: string,
): string {
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n')
  return createHmac(
    'sha256',
    signingKey(args.secretAccessKey, stamp.slice(0, 8), args.region, service),
  )
    .update(stringToSign)
    .digest('hex')
}

/**
 * Header-sign a request. Returns the headers to attach: `authorization`,
 * `x-amz-date`, `x-amz-content-sha256`, and `host` (informational — fetch
 * derives Host from the URL itself).
 */
export function signRequest(args: SignRequestArgs): Record<string, string> {
  const service = args.service ?? 's3'
  const stamp = amzDate(args.date ?? new Date())
  const payloadHash = args.payloadSha256 ?? UNSIGNED_PAYLOAD
  const toSign: Record<string, string> = {
    host: args.url.host,
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
  }
  for (const [k, v] of Object.entries(args.headers ?? {})) {
    toSign[k.toLowerCase()] = v.trim().replace(/ +/g, ' ')
  }
  const names = Object.keys(toSign).sort()
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    args.method.toUpperCase(),
    canonicalUri(args.url.pathname),
    canonicalQuery(args.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${stamp.slice(0, 8)}/${args.region}/${service}/aws4_request`
  const sig = signature(args, service, stamp, scope, canonicalRequest)
  return {
    host: args.url.host,
    'x-amz-date': stamp,
    'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${sig}`,
  }
}

/**
 * Query-sign a URL (the presigned GET handed to a client). Only `host` is
 * signed; the payload hash is the literal UNSIGNED-PAYLOAD per the S3
 * presigned-GET convention.
 */
export function presignUrl(args: PresignUrlArgs): string {
  const service = args.service ?? 's3'
  const stamp = amzDate(args.date ?? new Date())
  const scope = `${stamp.slice(0, 8)}/${args.region}/${service}/aws4_request`
  const params: [string, string][] = [
    ...args.url.searchParams,
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${args.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(args.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  const query = canonicalQuery(params)
  const uri = canonicalUri(args.url.pathname)
  const canonicalRequest = [
    args.method.toUpperCase(),
    uri,
    query,
    `host:${args.url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n')
  const sig = signature(args, service, stamp, scope, canonicalRequest)
  return `${args.url.origin}${uri}?${query}&X-Amz-Signature=${sig}`
}
