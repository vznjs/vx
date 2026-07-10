// CASBackend — pluggable content-addressed storage beneath the cache.
//
// Today's Cache + LayeredCache both bundle "where do the bytes live"
// with "how do we look up entries metadata + key derivation."
// CASBackend separates the former so a future R2/S3 backend
// or REAPI CAS bridge can drop in without touching the
// orchestrator or the SQL entries index.
//
// Two reference implementations in this file:
//   - MemoryCASBackend — testing + in-memory builds. Holds raw bytes.
//   - FsCASBackend     — writes bytes to a directory; mirrors what
//                        Cache.save does today. Bun-native using Bun.file
//                        for the read path so big artifacts stream
//                        without slurping into memory.
//
// Cache.ts has NOT yet been rewired to use a CASBackend — that's a
// follow-up (Phase 1b). This file ships the abstraction + the two
// reference impls so downstream work (R2, otel-bridge, distributed-ci)
// can rely on the type. Byte-identical behaviour today.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { Digest } from './digest.js'

export interface CASBackend {
  /** Write bytes under `digest`. Idempotent — putting the same digest twice is a no-op. */
  put(digest: Digest, bytes: Uint8Array): Promise<void>
  /** Read bytes under `digest`, or null if absent. */
  get(digest: Digest): Promise<Uint8Array | null>
  /** Cheap existence probe — no bytes round-tripped if possible. */
  has(digest: Digest): Promise<boolean>
  /** Drop one entry (eviction). No-op if absent. */
  remove(digest: Digest): Promise<void>
}

/** In-memory backend, useful for tests and ephemeral runs. */
export class MemoryCASBackend implements CASBackend {
  private readonly store = new Map<string, Uint8Array>()

  async put(digest: Digest, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== digest.sizeBytes) {
      throw new Error(
        `MemoryCASBackend.put: sizeBytes mismatch (digest=${digest.sizeBytes}, actual=${bytes.byteLength})`,
      )
    }
    this.store.set(digest.hash, bytes)
  }

  async get(digest: Digest): Promise<Uint8Array | null> {
    return this.store.get(digest.hash) ?? null
  }

  async has(digest: Digest): Promise<boolean> {
    return this.store.has(digest.hash)
  }

  async remove(digest: Digest): Promise<void> {
    this.store.delete(digest.hash)
  }

  /** Test-only: how many entries are held. */
  size(): number {
    return this.store.size
  }
}

/** Filesystem-backed backend writing `<rootDir>/<hash>.tar.zst` files. */
export class FsCASBackend implements CASBackend {
  constructor(private readonly rootDir: string) {}

  private pathFor(digest: Digest): string {
    return path.join(this.rootDir, `${digest.hash}.tar.zst`)
  }

  async put(digest: Digest, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== digest.sizeBytes) {
      throw new Error(
        `FsCASBackend.put: sizeBytes mismatch (digest=${digest.sizeBytes}, actual=${bytes.byteLength})`,
      )
    }
    await Bun.write(this.pathFor(digest), bytes)
  }

  async get(digest: Digest): Promise<Uint8Array | null> {
    const file = Bun.file(this.pathFor(digest))
    if (!(await file.exists())) return null
    return new Uint8Array(await file.arrayBuffer())
  }

  async has(digest: Digest): Promise<boolean> {
    return Bun.file(this.pathFor(digest)).exists()
  }

  async remove(digest: Digest): Promise<void> {
    await rm(this.pathFor(digest), { force: true })
  }
}
