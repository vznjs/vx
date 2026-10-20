// A scope keys only what plugins store themselves (ctx.cache, run records):
// task keys reach every remote plain, and a remote decides which branch a
// read may see (VZN, 2026-10-20).

import { xxh3hex } from '../util/index.js'

/** The key a scope stores `hash` under: task-key shaped, 16 hex, so every wire stores it unchanged. */
export function scopedKey(scope: string, hash: string): string {
  return xxh3hex(`vx-cache-scope\0${scope}\0${hash}`)
}
