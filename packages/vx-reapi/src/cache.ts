// vx's `RemoteCacheLayer` (has / get / put) over REAPI's ActionCache + CAS.
//
// The mapping, and why it needs the AC at all: a CAS digest is the sha256 of
// the CONTENT, so it cannot be derived from a vx cache key before the bytes
// exist — `has(key)` could never answer. The ActionCache supplies exactly the
// missing indirection: a SYNTHETIC action digest derived from the vx key
// addresses an ActionResult whose single output file points at the artifact
// blob in CAS. This is the convention Gradle and sccache use to reuse an AC
// as a general key/value cache.

import { createHash } from 'node:crypto'
import { type ActionResult, type Digest, ReapiClient, type ReapiOptions } from './wire.js'

/** The artifact's `output_files` path. Constant: the AC entry holds exactly one. */
const ARTIFACT_PATH = 'vx-artifact.tar.zst'

/**
 * Namespaced so a vx key can never collide with a real Bazel action digest
 * on a server shared with Bazel itself. The version prefix is what lets a
 * future change of this scheme miss cleanly rather than read a stale entry
 * under the same address.
 */
export function actionDigestFor(vxKey: string): Digest {
  const payload = Buffer.from(`vx-reapi-v1\0${vxKey}`, 'utf8')
  return { hash: createHash('sha256').update(payload).digest('hex'), size_bytes: payload.length }
}

/**
 * The EXECUTION record's address for a vx key — distinct from the artifact
 * mapping above. Where `actionDigestFor` points at one tarred artifact blob
 * (the vx cache entry), this points at an ActionResult listing the task's
 * outputs FILE BY FILE with workspace-relative paths: what a dependent's
 * input tree grafts by reference, so upstream outputs flow worker→CAS→worker
 * without ever landing on the submitter's disk.
 */
export function execDigestFor(vxKey: string): Digest {
  const payload = Buffer.from(`vx-reapi-exec-v1\0${vxKey}`, 'utf8')
  return { hash: createHash('sha256').update(payload).digest('hex'), size_bytes: payload.length }
}

export function digestOf(body: Uint8Array): Digest {
  return { hash: createHash('sha256').update(body).digest('hex'), size_bytes: body.length }
}

/**
 * `durationMs` rides the AC entry so a restored hit can report what the task
 * originally cost. REAPI models a build action, not a cache entry, so it has
 * no field for it — this uses `stdout_raw`, the one place whose BYTES a server
 * must round-trip verbatim and which nothing else in this mapping needs.
 * bazel-remote normalises inline stdout into a CAS blob and returns
 * `stdout_digest` instead, so the read path accepts either form.
 */
function encodeDuration(durationMs: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ durationMs }))
}

function decodeDuration(raw: Uint8Array | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { durationMs?: number }
    return typeof parsed.durationMs === 'number' ? parsed.durationMs : undefined
  } catch {
    return undefined
  }
}

export class ReapiRemoteCache {
  private readonly client: ReapiClient

  constructor(opts: ReapiOptions) {
    this.client = new ReapiClient(opts)
  }

  /**
   * Existence probe — no artifact bytes, but it does confirm the artifact
   * still EXISTS rather than trusting the entry that names it.
   *
   * Servers disagree here, measured both ways: bazel-remote validates an
   * ActionResult's referenced blobs and hides a dangling entry, NativeLink
   * serves it. Without the second call, `has` on a NativeLink-style server
   * promises a hit that `get` then cannot honour — and the only consumer of
   * `has` is the `--dry` / `--graph` plan, whose entire job is predicting
   * hit vs miss. Costs one extra round trip, and only for a PREDICTED HIT:
   * a miss still answers in one call.
   */
  async has(hash: string): Promise<boolean> {
    const result = await this.client.getActionResult(actionDigestFor(hash))
    if (result === null) return false
    const file = result.output_files?.find((f) => f.path === ARTIFACT_PATH)
    if (file === undefined) return false
    return (await this.client.findMissingBlobs([file.digest])).length === 0
  }

  async get(hash: string): Promise<{ body: ArrayBuffer; durationMs: number | undefined } | null> {
    const result = await this.client.getActionResult(actionDigestFor(hash))
    if (result === null) return null
    const file = result.output_files?.find((f) => f.path === ARTIFACT_PATH)
    // An AC entry whose blob has been evicted from CAS is a MISS, not an
    // error: the two stores are pruned independently and a dangling entry is
    // an ordinary state, not a fault.
    if (file === undefined) return null
    const body = await this.client.readBlob(file.digest)
    if (body === null) return null
    return {
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      durationMs: await this.durationOf(result),
    }
  }

  private async durationOf(result: ActionResult): Promise<number | undefined> {
    if (result.stdout_raw !== undefined && result.stdout_raw.length > 0) {
      return decodeDuration(result.stdout_raw)
    }
    // The server normalised our inline bytes into CAS (bazel-remote does).
    if (result.stdout_digest !== undefined && result.stdout_digest.size_bytes > 0) {
      const raw = await this.client.readBlob(result.stdout_digest)
      return decodeDuration(raw ?? undefined)
    }
    return undefined
  }

  async put(
    hash: string,
    body: ArrayBuffer | Uint8Array,
    meta: { durationMs: number },
  ): Promise<void> {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
    const digest = digestOf(bytes)
    // Upload only what the server lacks. The artifact is content-addressed and
    // immutable, so a hit here is a free skip rather than an optimisation.
    const missing = await this.client.findMissingBlobs([digest])
    if (missing.length > 0) await this.client.writeBlob(digest, bytes)
    await this.client.updateActionResult(actionDigestFor(hash), {
      exit_code: 0,
      output_files: [{ path: ARTIFACT_PATH, digest, is_executable: false }],
      stdout_raw: encodeDuration(meta.durationMs),
    })
  }

  close(): void {
    this.client.close()
  }
}
