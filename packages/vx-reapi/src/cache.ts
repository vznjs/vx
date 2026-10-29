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
import { ui } from '@vzn/vx'

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

/** `digestOf` in one pass over a Blob's stream, so a file-backed artifact is never held. */
async function streamedDigestOf(body: Blob): Promise<Digest> {
  const hash = createHash('sha256')
  for await (const chunk of body.stream()) hash.update(chunk)
  return { hash: hash.digest('hex'), size_bytes: body.size }
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

/** The duration a record carries; throws on bytes that are not one. */
function decodeDuration(raw: Uint8Array | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as { durationMs?: number }
  return typeof parsed.durationMs === 'number' ? parsed.durationMs : undefined
}

/** Artifacts up to this size are batch-uploaded without a FindMissingBlobs probe. */
const SMALL_PUT_BYTES = 256 * 1024

export class ReapiRemoteCache {
  private readonly client: ReapiClient
  /** Named in core's degrade line: a gRPC status carries no server. */
  readonly endpoint: string
  private readonly onWarn: (message: string) => void
  /** What was said already: a fault every hit meets is said once a run. */
  private readonly said = new Set<string>()

  constructor(opts: ReapiOptions) {
    this.client = new ReapiClient(opts)
    this.endpoint = opts.endpoint
    this.onWarn = opts.onWarn ?? ((m) => ui.say('warn', `[vx] ${m}`))
  }

  /** A fault the cache works around, said once per kind (2026-10-23: none is silent). */
  private warn(kind: string, err: unknown): void {
    if (this.said.has(kind)) return
    this.said.add(kind)
    this.onWarn(
      `vx/reapi: ${kind} at ${this.endpoint} failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  /** The duration a hit carries; one that cannot be read is unknown, and said. */
  private duration(raw: Uint8Array | undefined): number | undefined {
    try {
      return decodeDuration(raw)
    } catch (err) {
      this.warn('reading a task duration', err)
      return undefined
    }
  }

  /**
   * Existence probe — no artifact bytes, but it does confirm the artifact
   * still EXISTS rather than trusting the entry that names it.
   *
   * Servers disagree here, measured both ways: bazel-remote validates an
   * ActionResult's referenced blobs and hides a dangling entry, NativeLink
   * serves it. Without the second call, `has` on a NativeLink-style server
   * promises a hit that `get` then cannot honour — and the only consumer of
   * `has` is the `--dry` plan, whose entire job is predicting
   * hit vs miss. Costs one extra round trip, and only for a PREDICTED HIT:
   * a miss still answers in one call.
   */
  async has(hash: string): Promise<{ size: number; durationMs?: number } | null> {
    const result = await this.client.getActionResult(actionDigestFor(hash))
    if (result === null) return null
    const file = result.output_files?.find((f) => f.path === ARTIFACT_PATH)
    if (file === undefined) return null
    if ((await this.client.findMissingBlobs([file.digest])).length > 0) return null
    // The duration only when it rode inline: a CAS read for it is a round trip.
    const durationMs = this.duration(result.stdout_raw)
    return {
      size: Number(file.digest.size_bytes),
      ...(durationMs === undefined ? {} : { durationMs }),
    }
  }

  /**
   * The artifact streams from the ByteStream read into core's ingest. The
   * duration (which a server may have moved into CAS) is read alongside the
   * artifact's open, not before it: one round trip less per remote hit
   * (130 → 99 ms at 15 ms one-way against bazel-remote, F-24). The open
   * waits only for its first message, so the call is not left paused.
   */
  async get(hash: string): Promise<{ body: Response; durationMs: number | undefined } | null> {
    // Inline: a server that honours it answers a small hit in this one round
    // trip, duration and artifact both (bazel-remote inlines up to ~1 MiB);
    // one that declines costs nothing (F-25).
    const result = await this.client.getActionResult(actionDigestFor(hash), {
      stdout: true,
      files: [ARTIFACT_PATH],
    })
    if (result === null) return null
    const file = result.output_files?.find((f) => f.path === ARTIFACT_PATH)
    // An AC entry whose blob has been evicted from CAS is a MISS, not an
    // error: the two stores are pruned independently and a dangling entry is
    // an ordinary state, not a fault.
    if (file === undefined) return null
    // Inline bytes are held to the digest they ride with, as fetched ones
    // are: a mismatch streams the blob instead (F-8's rule).
    const inline =
      file.contents !== undefined &&
      file.contents.length > 0 &&
      digestOf(file.contents).hash === file.digest.hash
        ? file.contents
        : undefined
    const [durationMs, body] = await Promise.all([
      this.durationOf(result),
      inline === undefined ? this.client.readBlobStream(file.digest) : inline,
    ])
    if (body === null) return null
    return { body: new Response(body), durationMs }
  }

  private async durationOf(result: ActionResult): Promise<number | undefined> {
    if (result.stdout_raw !== undefined && result.stdout_raw.length > 0) {
      return this.duration(result.stdout_raw)
    }
    // The server normalised our inline bytes into CAS (bazel-remote does).
    // An absent digest arrives as `null` on this path (proto-loader's
    // message default, as `this_readStream` in executor.ts records).
    // The duration is metadata: a read of it that fails (retries spent, a
    // blob failing its digest) leaves it unknown, where it made core drop a
    // valid hit as a miss (F-21).
    if ((result.stdout_digest?.size_bytes ?? 0) > 0) {
      const raw = await this.client.readBlob(result.stdout_digest!).catch((err: unknown) => {
        this.warn('reading a task duration', err)
        return null
      })
      return this.duration(raw ?? undefined)
    }
    return undefined
  }

  /**
   * An artifact past `writeBlob`'s whole read takes two passes over `body`,
   * never one in memory: the digest first (the CAS address must be known
   * before the server is asked), then the upload from a second read of the
   * stream.
   */
  async put(hash: string, body: Blob, meta: { durationMs: number }): Promise<void> {
    // An entry is immutable, and UpdateActionResult replaces one: the
    // lookup runs beside the upload (CAS writes are idempotent), so a key
    // stored already costs no round trip of its own and keeps its result.
    // A lookup that fails writes, as before.
    const action = actionDigestFor(hash)
    const stored = this.client.getActionResult(action).then(
      (r) => r?.output_files?.find((f) => f.path === ARTIFACT_PATH)?.digest,
      (err: unknown) => {
        this.warn('looking up a stored entry before an upload', err)
        return undefined
      },
    )
    // Read once, and those bytes hashed and sent, wherever `writeBlob` would
    // read the Blob whole anyway: a second writer of the key renames its
    // artifact over the file, and two reads sent its bytes under this one's
    // digest (F-50).
    const data = body.size <= this.client.wholeWriteBytes ? await body.bytes() : undefined
    const digest = data === undefined ? await streamedDigestOf(body) : digestOf(data)
    if (data !== undefined && data.length <= SMALL_PUT_BYTES) {
      // A small artifact is sent in one batch without asking first: the
      // probe was a round trip of its own to save an upload no larger than
      // it (102 → 71 ms per save at 15 ms one-way, F-26). Content-addressed,
      // so a re-send is harmless.
      // A server whose batch limit is smaller refuses it; stream instead.
      await this.client.batchUpdateBlobs([{ digest, data }]).catch((err: unknown) => {
        this.warn('a batch upload (streamed instead)', err)
        return this.client.writeBlob(digest, data)
      })
    } else {
      // Upload only what the server lacks: for a large artifact the probe is
      // cheap next to the bytes it can skip.
      const missing = await this.client.findMissingBlobs([digest])
      if (missing.length > 0) await this.client.writeBlob(digest, data ?? body)
    }
    // The two stores are pruned apart: an entry whose blob is gone is a
    // miss every run, and kept, its key never hit again.
    const kept = await stored
    if (
      kept !== undefined &&
      (kept.hash === digest.hash || (await this.client.findMissingBlobs([kept])).length === 0)
    ) {
      return
    }
    await this.client.updateActionResult(action, {
      exit_code: 0,
      output_files: [{ path: ARTIFACT_PATH, digest, is_executable: false }],
      stdout_raw: encodeDuration(meta.durationMs),
    })
  }

  close(): void {
    this.client.close()
  }
}
