// xxh3 / xxh3hex is THE cache-key primitive: every task hash, the
// workspace fingerprint, the config-load module bust and the verify
// output fingerprint fold through it. A defect here is not a cosmetic
// bug — it is a WRONG CACHE HIT (two different inputs sharing a key)
// or a cache-wide invalidation (the same input changing key).
//
// Three properties are load-bearing and each has its own block below:
//
//   1. Known answers. `Cache.key()` seeds every chain with the literal
//      CACHE_VERSION string, so if the algorithm or the DEFAULT SEED
//      ever moved, every entry on every machine would be orphaned
//      silently. Pinned against the published xxHash3 reference
//      vectors AND re-derived a second, independent way in-test.
//
//   2. Fixed 16-char hex. The digest is a FILENAME
//      (`<cacheDir>/<hash>.tar.zst`) and a SQLite primary key. A
//      digest whose top nibbles are zero renders short without the
//      padStart — `0000afad951a38eb` would become `afad951a38eb`,
//      which is a different filename for the same key AND collides
//      with any future key that legitimately renders those 12 chars.
//      ~6% of all digests have at least one leading zero nibble, so
//      this is an everyday path, not a corner.
//
//   3. Seed chaining is unambiguous. `Cache.key()` folds N parts as
//      `xxh3(part, prevDigest)` rather than concatenating them, so
//      that no combination of part CONTENTS can make two different
//      part lists fold the same bytes. That is the structural half of
//      the v18 fix (CLAUDE.md 2026-06); the delimiter inside a part
//      is the other half and is pinned here too.

import { describe, expect, it } from 'bun:test'
import { xxh3, xxh3hex } from '../src/util/hash.js'
import { xxh3 as xxh3ViaBarrel, xxh3hex as xxh3hexViaBarrel } from '../src/util/index.js'

/**
 * Independent hex renderer: big-endian byte-wise, the shape the module
 * comment cites Turbo as using (`hex(to_be_bytes(u64))`). Deliberately
 * NOT `toString(16).padStart(...)` — this is the second opinion that
 * catches a padding regression in xxh3hex.
 */
function hexFromU64(v: bigint): string {
  let out = ''
  for (let shift = 56n; shift >= 0n; shift -= 8n) {
    out += Number((v >> shift) & 0xffn)
      .toString(16)
      .padStart(2, '0')
  }
  return out
}

/** The exact fold shape Cache.key() uses: seed-chain over ordered parts. */
function fold(parts: ReadonlyArray<string | Uint8Array>): bigint {
  let h = 0n
  for (const p of parts) h = xxh3(p, h)
  return h
}

function popcount64(v: bigint): number {
  let n = 0
  let x = v
  while (x > 0n) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

const utf8 = (s: string) => new TextEncoder().encode(s)

describe('xxh3 — known answers', () => {
  // Published XXH3_64bits reference vectors (seed 0). These are the
  // canary for "Bun swapped the algorithm" or "the default seed moved
  // off 0n" — either would silently orphan every cache entry that
  // exists in the wild, with no error anywhere.
  it('matches the published XXH3_64bits vectors for "" and "abc"', () => {
    expect(xxh3('')).toBe(0x2d06800538d394c2n)
    expect(xxh3('abc')).toBe(0x78af5f94892f3950n)
  })

  it('the default seed is exactly 0n (Cache.key seeds its chain from it)', () => {
    // `let h = xxh3(CACHE_VERSION)` in cache.ts relies on the implicit
    // seed. If the default drifted, the CACHE_VERSION namespace would
    // move without a version bump.
    for (const s of ['', 'abc', 'vx-cache-v24', 'pkg#build']) {
      expect(xxh3(s)).toBe(xxh3(s, 0n))
    }
  })

  it('is deterministic across repeated calls', () => {
    for (const s of ['', 'abc', 'pkg#build', '日本語']) {
      expect(xxh3(s)).toBe(xxh3(s))
      expect(xxh3hex(s)).toBe(xxh3hex(s))
    }
  })

  it('the barrel re-export is the same function (production imports go through it)', () => {
    // Every production caller does `from '../util/index.js'`. A barrel
    // that re-exported a different symbol would make this file's
    // guarantees vacuous for the real code paths.
    expect(xxh3ViaBarrel).toBe(xxh3)
    expect(xxh3hexViaBarrel).toBe(xxh3hex)
    expect(xxh3ViaBarrel('abc')).toBe(0x78af5f94892f3950n)
    expect(xxh3hexViaBarrel('abc')).toBe('78af5f94892f3950')
  })
})

describe('xxh3hex — fixed 16-char rendering', () => {
  // Found by brute force: `xxh3('vx61481')` = 0xafad951a38eb, whose
  // natural toString(16) is only 12 chars. Without padStart the cache
  // would write `afad951a38eb.tar.zst` while the SQLite row (and any
  // consumer that re-derives the key) expects 16 chars.
  const leadingZeroCases: Array<[input: string, raw: string, padded: string]> = [
    ['vx1', '6ef6bc7c6a41dbd', '06ef6bc7c6a41dbd'],
    ['vx299', 'c873c7a2d8adfd', '00c873c7a2d8adfd'],
    ['vx3036', '38b5daf23cebf', '00038b5daf23cebf'],
    ['vx61481', 'afad951a38eb', '0000afad951a38eb'],
  ]

  for (const [input, raw, padded] of leadingZeroCases) {
    it(`zero-pads a ${16 - raw.length}-nibble-short digest (${input})`, () => {
      // Guard the fixture itself: if these inputs stop producing short
      // digests the test would silently stop testing padding.
      expect(xxh3(input).toString(16)).toBe(raw)
      expect(xxh3hex(input)).toBe(padded)
      expect(xxh3hex(input)).toHaveLength(16)
    })
  }

  it('renders exactly 16 lowercase hex chars for every sampled digest', () => {
    // ~6% of digests have a leading zero nibble, so 5k samples make a
    // width regression a certainty rather than a coin flip.
    for (let i = 0; i < 5000; i++) {
      const hex = xxh3hex(`pkg${i}#build`)
      expect(hex).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('never renders a sign (the digest domain is unsigned u64)', () => {
    // A signed reading of the u64 would make toString(16) emit a
    // leading '-', which padStart cannot repair — the filename would
    // be 17 chars and start with a dash.
    for (let i = 0; i < 20000; i++) {
      const d = xxh3(`k${i}`)
      expect(d >= 0n).toBe(true)
      expect(d < 2n ** 64n).toBe(true)
    }
  })

  it('agrees with an independent big-endian byte-wise renderer', () => {
    // Second opinion on the padding: hexFromU64 pads per BYTE, so it
    // cannot share a bug with padStart(16, '0').
    for (const s of ['', 'abc', 'vx1', 'vx61481', 'vx299', 'vx3036', '日本語']) {
      expect(xxh3hex(s)).toBe(hexFromU64(xxh3(s)))
    }
  })

  it('is exactly xxh3 rendered — the two exports cannot disagree on the seed', () => {
    // xxh3hex takes its own `seed` default; if the two drifted, a
    // caller mixing xxh3() for chaining and xxh3hex() for the final
    // render (which is precisely what Cache.key does) would produce a
    // key nobody can reproduce.
    for (const seed of [0n, 1n, 0xdeadbeefn, 2n ** 63n]) {
      for (const s of ['', 'abc', 'vx61481']) {
        expect(xxh3hex(s, seed)).toBe(hexFromU64(xxh3(s, seed)))
      }
    }
  })

  it('a seeded digest is padded too (chained folds land here)', () => {
    // Cache.key's final `h` is a SEEDED digest — the padding path that
    // actually ships is the seeded one.
    const hex = xxh3hex('p2340', 7n)
    expect(xxh3('p2340', 7n).toString(16)).toBe('6b21cda30698d')
    expect(hex).toBe('0006b21cda30698d')
  })
})

describe('xxh3 seed chaining — the Cache.key fold', () => {
  it('the seed genuinely participates (a chain step is not a plain re-hash)', () => {
    // The single most important discriminator in this file: if the
    // seed were dropped, every chain would collapse to "hash of the
    // LAST part" and a task's key would ignore every input but one.
    expect(xxh3('abc', 1n)).not.toBe(xxh3('abc'))
    expect(xxh3('abc', 1n)).not.toBe(xxh3('abc', 2n))
    const prev = xxh3('vx-cache-v24')
    expect(xxh3('task:pkg#build', prev)).not.toBe(xxh3('task:pkg#build'))
  })

  it('a one-bit seed change avalanches through the digest', () => {
    // Guards a "seed is mixed in weakly / only into the low bits"
    // regression, which would let near-identical upstream hashes
    // collapse into the same key.
    const diff = popcount64(xxh3('x', 0n) ^ xxh3('x', 1n))
    expect(diff).toBeGreaterThanOrEqual(16)
  })

  it('order matters: fold(a,b) !== fold(b,a)', () => {
    // Cache.key folds labelled sections in a fixed order; swapping two
    // sections must not be a no-op, or an env value could masquerade
    // as an input-file OID.
    expect(fold(['a', 'b'])).not.toBe(fold(['b', 'a']))
    expect(fold(['task:x', 'config:y'])).not.toBe(fold(['config:y', 'task:x']))
  })

  it('chained parts never fold the same bytes as their concatenation', () => {
    // The structural anti-ambiguity property. A concat-based hash would
    // give fold(['a','b']) === xxh3('ab'); the seed chain must not.
    expect(fold(['a', 'b'])).not.toBe(xxh3('ab'))
    expect(fold(['A', 'B', 'C'])).not.toBe(xxh3('ABC'))
    expect(fold(['env-values:1', 'A'])).not.toBe(xxh3('env-values:1A'))
  })

  it('no split point of a string folds to the same digest as another', () => {
    // Exhaustive over every split of an 8-char string: 9 part-lists,
    // 9 distinct digests. This is what makes "part contents cannot
    // create ambiguity ACROSS parts" a proven claim rather than an
    // assumption — the caller may put any bytes in any part.
    const s = 'abcdefgh'
    const digests = new Set<bigint>()
    for (let i = 0; i <= s.length; i++) digests.add(fold([s.slice(0, i), s.slice(i)]))
    expect(digests.size).toBe(s.length + 1)
  })

  it('an empty part still moves the chain (presence is signal)', () => {
    // `cap`/count sections fold zero-length strings; if an empty part
    // were a no-op, "one empty env value" and "no env value at all"
    // would share a key.
    expect(fold(['a', ''])).not.toBe(fold(['a']))
    expect(fold(['', ''])).not.toBe(fold(['']))
    expect(fold([''])).not.toBe(0n)
  })

  it('a zero-length chain is the identity seed', () => {
    // Documents the base case Cache.key starts from: fold([]) === 0n,
    // so the first real step is an unseeded xxh3 of CACHE_VERSION.
    expect(fold([])).toBe(0n)
    expect(fold(['x'])).toBe(xxh3('x'))
  })

  it('a long chain is deterministic and length-sensitive', () => {
    const parts = Array.from({ length: 200 }, (_, i) => `inputs/file-${i}.ts`)
    expect(fold(parts)).toBe(fold(parts))
    expect(fold(parts)).not.toBe(fold(parts.slice(0, 199)))
    // Reordering a single adjacent pair must change the key — the
    // sorted-inputs guarantee in Cache.key exists because of this.
    const swapped = [...parts]
    ;[swapped[7], swapped[8]] = [swapped[8]!, swapped[7]!]
    expect(fold(swapped)).not.toBe(fold(parts))
  })

  it('mixed string / Uint8Array parts chain interchangeably', () => {
    // computeWorkspaceFingerprint chains a string label then raw file
    // BYTES into the same running digest. Both part types must feed
    // one chain identically.
    expect(fold(['bun.lock\0', utf8('contents')])).toBe(fold(['bun.lock\0', 'contents']))
    expect(fold([utf8('a'), 'b'])).toBe(fold(['a', utf8('b')]))
  })
})

describe('xxh3 chaining — the v18 delimiter invariant', () => {
  // CLAUDE.md 2026-06 (CACHE_VERSION v18): Cache.key folds env pairs as
  // `${name}\0${value}`. It used to use `=`, and ("A", "B=C") folded
  // the same bytes as ("A=B", "C") — a wrong cache hit across two
  // genuinely different environments.
  const foldEnvPairs = (pairs: ReadonlyArray<[string, string]>, sep: string): bigint =>
    fold([`env-values:${pairs.length}`, ...pairs.map(([n, v]) => `${n}${sep}${v}`)])

  it('the "=" delimiter DID collide — the bug the v18 bump fixed', () => {
    // Pinned so the regression is visible if anyone reaches for a
    // "prettier" delimiter that can appear in a name or a value.
    const a = foldEnvPairs([['A', 'B=C']], '=')
    const b = foldEnvPairs([['A=B', 'C']], '=')
    expect(a).toBe(b)
  })

  it('the NUL delimiter separates them (a value may contain "=")', () => {
    const a = foldEnvPairs([['A', 'B=C']], '\0')
    const b = foldEnvPairs([['A=B', 'C']], '\0')
    expect(a).not.toBe(b)
    expect(xxh3hex(a.toString(16))).toHaveLength(16)
  })

  it('NUL survives into the hashed bytes rather than truncating the part', () => {
    // A C-string-style implementation would stop at the first NUL,
    // silently making every `${name}\0${value}` fold as just the name —
    // i.e. env VALUES would drop out of the cache key entirely.
    expect(xxh3('A\0B')).not.toBe(xxh3('A'))
    expect(xxh3('A\0B')).not.toBe(xxh3('A\0C'))
    expect(xxh3('A\0B')).not.toBe(xxh3('AB'))
    expect(xxh3(utf8('A\0B'))).toBe(xxh3('A\0B'))
  })

  it('the invariant is ACROSS parts, not within one — names must stay NUL-free', () => {
    // Honest scoping of the guarantee. Within a single part the
    // delimiter is only unambiguous because the domain excludes it: a
    // POSIX environ name can contain neither '=' nor NUL. Two parts,
    // by contrast, can never be confused whatever they contain.
    const withinPart = fold(['A\0B\0C'])
    expect(fold([`A\0${'B\0C'}`])).toBe(withinPart)
    expect(fold([`${'A\0B'}\0C`])).toBe(withinPart)
    // Across parts there is no such aliasing.
    expect(fold(['A', 'B\0C'])).not.toBe(fold(['A\0B', 'C']))
  })

  it('the section count prefix distinguishes an empty section from an empty member', () => {
    // `env-values:0` vs `env-values:1` + one empty pair — Cache.key
    // folds the count precisely so these two cannot alias.
    expect(foldEnvPairs([], '\0')).not.toBe(foldEnvPairs([['', '']], '\0'))
  })
})

describe('xxh3 — input domain', () => {
  it('a string and its UTF-8 bytes hash identically', () => {
    // Load-bearing: Cache.key folds STRINGS (`${rel}\0${oid}`) while
    // computeWorkspaceFingerprint and verify.ts fold raw file BYTES.
    // If Bun encoded strings as latin1 the two would live in different
    // domains and a "hash of the same content" claim would be false.
    for (const s of ['', 'abc', 'é', 'naïve', '日本語', '\u{1F389}', 'a\0b', ' \t\n']) {
      expect(xxh3(s)).toBe(xxh3(utf8(s)))
    }
    // Explicitly NOT latin1: 'é' is two UTF-8 bytes, not the byte 0xE9.
    expect(xxh3('é')).not.toBe(xxh3(new Uint8Array([0xe9])))
    expect(xxh3('é')).toBe(xxh3(new Uint8Array([0xc3, 0xa9])))
  })

  it('the empty string and the empty byte array share the reference vector', () => {
    expect(xxh3('')).toBe(xxh3(new Uint8Array(0)))
    expect(xxh3hex('')).toBe('2d06800538d394c2')
  })

  it('distinguishes unicode strings that differ only in normalization', () => {
    // 'é' as one code point vs 'e' + combining acute. Two distinct
    // file names on disk, so two distinct keys.
    expect(xxh3('é')).not.toBe(xxh3('é'))
  })

  it('hashes a Uint8Array VIEW by its own window, not the backing buffer', () => {
    // Output artifacts are read via Bun.file(...).bytes(); a subarray
    // that hashed its whole backing buffer would make two different
    // slices share a digest.
    const backing = utf8('xxabcxx')
    expect(xxh3(backing.subarray(2, 5))).toBe(xxh3('abc'))
    expect(xxh3(backing.subarray(0, 3))).not.toBe(xxh3(backing.subarray(2, 5)))
  })

  it('bytes outside the UTF-8 range still hash (binary artifacts are inputs)', () => {
    const bin = new Uint8Array([0x00, 0xff, 0x80, 0xfe, 0x00, 0x7f])
    expect(xxh3hex(bin)).toMatch(/^[0-9a-f]{16}$/)
    const flipped = new Uint8Array(bin)
    flipped[3] = 0xfd
    expect(xxh3(flipped)).not.toBe(xxh3(bin))
  })

  it('a multi-megabyte buffer hashes correctly at both ends', () => {
    // xxh3 switches internal code paths by length (short / mid / long);
    // a chunk-boundary bug would typically ignore the head or the tail.
    const big = new Uint8Array(4 * 1024 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff
    const base = xxh3(big)
    expect(xxh3(big)).toBe(base)
    expect(xxh3hex(big)).toHaveLength(16)

    const firstFlipped = new Uint8Array(big)
    firstFlipped[0] ^= 1
    expect(xxh3(firstFlipped)).not.toBe(base)

    const lastFlipped = new Uint8Array(big)
    lastFlipped[lastFlipped.length - 1] ^= 1
    expect(xxh3(lastFlipped)).not.toBe(base)

    const midFlipped = new Uint8Array(big)
    midFlipped[big.length >> 1] ^= 1
    expect(xxh3(midFlipped)).not.toBe(base)

    // Truncation must change the digest (a length-blind hash would let
    // a truncated artifact restore under the full artifact's key).
    expect(xxh3(big.subarray(0, big.length - 1))).not.toBe(base)
  })

  it('a multi-megabyte buffer does not hash pathologically slowly', () => {
    // Measured ~1ms for 4 MiB; the bound is ~1000x headroom so it only
    // fires on an algorithmic regression (e.g. a per-byte JS fallback),
    // never on a loaded CI box.
    const big = new Uint8Array(4 * 1024 * 1024)
    const t0 = Bun.nanoseconds()
    xxh3(big)
    expect((Bun.nanoseconds() - t0) / 1e6).toBeLessThan(1000)
  })

  it('a lone surrogate is encoded lossily — documented, not a hash defect', () => {
    // Bun encodes strings as UTF-8, and an unpaired surrogate has no
    // UTF-8 form, so it becomes U+FFFD. Two distinct JS strings
    // therefore share a digest. Recorded here as a KNOWN boundary of
    // the string overload: every path that reaches xxh3 with a path
    // name already went through TextDecoder, which performs the same
    // substitution, so the lossiness is upstream of the hash — but a
    // future caller hashing raw UTF-16 must use bytes, not a string.
    expect(xxh3('\ud800')).toBe(xxh3('�'))
  })
})

describe('xxh3 — digest domain', () => {
  it('100k distinct inputs produce 100k distinct digests', () => {
    // Catches the catastrophic regressions: a constant return, a
    // truncated digest, or a hash that ignores part of its input.
    const seen = new Set<bigint>()
    for (let i = 0; i < 100000; i++) seen.add(xxh3(`pkg${i}#build`))
    expect(seen.size).toBe(100000)
  })

  it('near-identical inputs avalanche (no shared prefix in the digest)', () => {
    const pairs: Array<[string, string]> = [
      ['vx-cache-v24', 'vx-cache-v25'],
      ['a', 'b'],
      ['pkg#build', 'pkg#builds'],
      ['', 'x'],
      ['deadbeef', 'deadbeee'],
    ]
    for (const [p, q] of pairs) {
      // Measured 29-35 differing bits for these pairs; >= 16 leaves
      // ample margin while still failing any truncating or
      // prefix-preserving implementation.
      expect(popcount64(xxh3(p) ^ xxh3(q))).toBeGreaterThanOrEqual(16)
      expect(xxh3hex(p).slice(0, 4)).not.toBe(xxh3hex(q).slice(0, 4))
    }
  })

  it('digests spread across the full 64-bit range', () => {
    // A digest stuck in the low bits would still be "unique" but would
    // make the 16-char rendering permanently zero-padded and shrink the
    // effective key space.
    let anyHigh = false
    let anyLow = false
    for (let i = 0; i < 20000; i++) {
      const d = xxh3(`k${i}`)
      if (d >= 2n ** 63n) anyHigh = true
      if (d < 2n ** 48n) anyLow = true
    }
    expect(anyHigh).toBe(true)
    expect(anyLow).toBe(true)
  })

  it('a digest is always a valid seed for the next step (the chain is closed)', () => {
    // Every value xxh3 can return must be an acceptable seed, or a
    // chain could throw mid-key-derivation on an unlucky digest.
    for (const probe of ['', 'abc', 'vx61481', 'vx1']) {
      const d = xxh3(probe)
      expect(() => xxh3('next', d)).not.toThrow()
      expect(xxh3hex('next', d)).toMatch(/^[0-9a-f]{16}$/)
    }
    // Domain endpoints, which a digest can legitimately be.
    expect(() => xxh3('next', 0n)).not.toThrow()
    expect(() => xxh3('next', 2n ** 64n - 1n)).not.toThrow()
  })
})
