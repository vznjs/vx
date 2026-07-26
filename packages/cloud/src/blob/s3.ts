// S3-compatible blob storage (MinIO / R2 / Garage / AWS) — path-style URLs,
// hand-rolled SigV4, no AWS SDK (docs/design/s3-blob-backend-2026-07.md).
// Requests THROW on any failure (status + the first bytes of the body); the
// store maps a throw to a loud 502 so a broken bucket never degrades into a
// silent 404-as-miss. Uploads ride `UNSIGNED-PAYLOAD` (the aws-cli streaming
// convention — TLS carries transport integrity; the artifact's own integrity
// is the client-verified `x-vx-digest`, stored as S3 user metadata).

import { awsUriEncode, presignUrl, signRequest } from './sigv4.js'
import type { BlobBackend, BlobListEntry, BlobStat } from './backend.js'

export interface S3BackendConfig {
  /** `https://s3.example.com` — the bucket rides the path (path-style, the
   *  compatible-store baseline; AWS accepts it too). */
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Optional key prefix inside the bucket (`vx-cache/`). */
  prefix?: string
  /** Presigned-GET TTL in seconds. Default 300. */
  presignTtlSeconds?: number
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 30_000

/** ListObjectsV2 pagination cap — 8 pages × 1000 keys dwarfs any
 *  `/v1/artifacts` limit; a runaway-truncated response can't loop forever. */
const MAX_LIST_PAGES = 8

/** The S3 user-metadata header names carrying the vx wire metadata. The
 *  bucket echoes these verbatim on GET, so `NativeCacheClient` reads them as
 *  fallbacks for `x-vx-digest` / `x-vx-duration-ms` on an offloaded (307)
 *  response. */
export const S3_META_DIGEST = 'x-amz-meta-vx-digest'
export const S3_META_DURATION_MS = 'x-amz-meta-vx-duration-ms'

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export class S3Backend implements BlobBackend {
  private readonly endpoint: string
  private readonly prefix: string
  private readonly ttl: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: S3BackendConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '')
    this.prefix = config.prefix ?? ''
    this.ttl = config.presignTtlSeconds ?? 300
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  localPathFor(): null {
    return null
  }

  private objectUrl(key: string): URL {
    const encodedKey = `${this.prefix}${key}`.split('/').map(awsUriEncode).join('/')
    return new URL(`${this.endpoint}/${awsUriEncode(this.config.bucket)}/${encodedKey}`)
  }

  async head(key: string): Promise<BlobStat | null> {
    const res = await this.request('HEAD', this.objectUrl(key))
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`S3 HEAD ${key} → ${res.status}`)
    const meta: Record<string, string> = {}
    const digest = res.headers.get(S3_META_DIGEST)
    if (digest !== null) meta['digest'] = digest
    const duration = res.headers.get(S3_META_DURATION_MS)
    if (duration !== null) meta['durationMs'] = duration
    const lm = res.headers.get('last-modified')
    const storedAt = lm !== null ? Date.parse(lm) : NaN
    return {
      size: Number(res.headers.get('content-length') ?? '0'),
      storedAt: Number.isFinite(storedAt) ? storedAt : Date.now(),
      meta,
    }
  }

  async put(key: string, file: string, size: number, meta: Record<string, string>): Promise<void> {
    // x-amz-* headers MUST be signed; content-length is deliberately not (the
    // runtime derives it from the file body — same value, set explicitly too).
    const signedHeaders: Record<string, string> = {}
    const digest = meta['digest']
    if (digest !== undefined) signedHeaders[S3_META_DIGEST] = digest
    const duration = meta['durationMs']
    if (duration !== undefined) signedHeaders[S3_META_DURATION_MS] = duration
    const res = await this.request('PUT', this.objectUrl(key), {
      signedHeaders,
      extraHeaders: { 'content-length': String(size) },
      body: Bun.file(file),
    })
    if (!res.ok) throw new Error(`S3 PUT ${key} → ${res.status}${await bodyHead(res)}`)
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', this.objectUrl(key))
    // S3 answers 204 whether or not the key existed (delete is idempotent by
    // spec); some compatible stores answer 404 for an absent key. Both mean
    // gone — only a real refusal (403, 5xx) is a failure.
    if (res.ok || res.status === 404) return
    throw new Error(`S3 DELETE ${key} → ${res.status}${await bodyHead(res)}`)
  }

  presignGet(key: string): string {
    return presignUrl({
      method: 'GET',
      url: this.objectUrl(key),
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresSeconds: this.ttl,
    })
  }

  async list(prefix: string): Promise<BlobListEntry[]> {
    const out: BlobListEntry[] = []
    const fullPrefix = `${this.prefix}${prefix}/`
    let token: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params: [string, string][] = [
        ['list-type', '2'],
        ['prefix', fullPrefix],
      ]
      if (token !== undefined) params.push(['continuation-token', token])
      const query = params.map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&')
      const url = new URL(`${this.endpoint}/${awsUriEncode(this.config.bucket)}/?${query}`)
      const res = await this.request('GET', url)
      if (!res.ok) throw new Error(`S3 LIST ${prefix} → ${res.status}${await bodyHead(res)}`)
      const xml = await res.text()
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const block = m[1]!
        const rawKey = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]
        if (rawKey === undefined) continue
        const fullKey = xmlUnescape(rawKey)
        if (!fullKey.startsWith(this.prefix)) continue
        const lm = /<LastModified>([^<]*)<\/LastModified>/.exec(block)?.[1]
        const storedAt = lm !== undefined ? Date.parse(lm) : NaN
        out.push({
          key: fullKey.slice(this.prefix.length),
          size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? '0'),
          storedAt: Number.isFinite(storedAt) ? storedAt : Date.now(),
        })
      }
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || next === undefined) break
      token = xmlUnescape(next)
    }
    return out
  }

  private async request(
    method: string,
    url: URL,
    init?: {
      /** Headers folded into the SigV4 canonical request AND sent. */
      signedHeaders?: Record<string, string>
      /** Sent but not signed (content-length — the runtime may rewrite it). */
      extraHeaders?: Record<string, string>
      body?: Blob
    },
  ): Promise<Response> {
    const signed = signRequest({
      method,
      url,
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      ...(init?.signedHeaders !== undefined ? { headers: init.signedHeaders } : {}),
    })
    // fetch derives Host from the URL; setting it explicitly is forbidden.
    delete signed['host']
    // Clearable timer, NOT AbortSignal.timeout — its internal timer is not
    // unref'd and would keep the CLI alive after the request resolved.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(url.toString(), {
        method,
        signal: controller.signal,
        headers: { ...init?.extraHeaders, ...init?.signedHeaders, ...signed },
        ...(init?.body !== undefined ? { body: init.body } : {}),
      })
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new Error(`S3 ${method} ${url.pathname} timed out after ${this.timeoutMs}ms`)
      }
      throw new Error(`S3 ${method} ${url.pathname} failed: ${(err as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

async function bodyHead(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 200)
  return text !== '' ? `: ${text}` : ''
}
