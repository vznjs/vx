// The bounded head-evicting tail — the only thing standing between a
// never-ready persistent task and an unbounded heap.
//
// CLAUDE.md 2026-07-27 (F10): a `readyWhen` that never matched grew vx's heap
// at ~100 MiB/s while a 64 KiB cap sat unused, because the cap only engaged
// once the task became READY. This module was extracted so one bound covers
// the whole lifetime, and `exec/runner.ts`'s second, unread copy was deleted
// rather than kept in sync. `orchestrator/logger.ts` is the sole holder.
//
// Four properties are load-bearing, and the file is organised around them:
//
//   1. THE BOUND HOLDS. `chars` never exceeds the limit, for any chunk shape,
//      any arrival order, any limit. This is the whole reason the file exists.
//   2. THE TAIL CAN NEVER READ AS COMPLETE. `dropped > 0` exactly when text
//      was lost — both directions. A truncated log that renders as whole is
//      worse than one that says what it lost, and `framed-output.ts:142`
//      prints "… N earlier characters dropped" off this counter alone.
//   3. CHUNKS ARE EVICTED WHOLE. The documented design: no concatenation
//      until the flush joins once, so a chatty server costs one array push
//      per chunk. The single-chunk-over-cap slice is the one exception.
//   4. NOTHING IS SILENTLY LOST OR INVENTED. `chars + dropped` equals every
//      code unit ever appended, and the retained text is always a genuine
//      suffix of the stream — never a re-ordered or re-split view of it.
//
// Verified against the source while writing: the header comment on
// src/util/tail.ts is ACCURATE. `logger.ts` really is the sole importer,
// `exec/runner.ts:331-335` really did drop its copy and now points at this
// one, and `util` really is forced by tests/module-boundaries.test.ts, which
// allows `exec: ['util', 'config']` and no path from `exec` to `orchestrator`.

import { describe, expect, it } from 'bun:test'
import {
  appendTail,
  createTail,
  PERSISTENT_TAIL_CHARS,
  resetTail,
  tailText,
  type Tail,
} from '../src/util/tail.js'
// logger.ts imports through the module CONTRACT, not the file, per
// tests/module-boundaries.test.ts. Dropping any of these FUNCTIONS from the
// barrel breaks the sole production holder, so their re-export is part of
// the surface. The cap constant is not: nothing in src reads it through the
// barrel (it left the barrel 2026-09-03), so it is pinned from the file.
import {
  appendTail as appendViaBarrel,
  createTail as createViaBarrel,
  resetTail as resetViaBarrel,
  tailText as tailTextViaBarrel,
} from '../src/util/index.js'

// CI runners are ~3× slower and noisier; the one perf guard below scales.
const PERF_SCALE = Number(process.env.VX_PERF_SCALE ?? (process.env.CI === 'true' ? '3' : '1'))

/** Deterministic PRNG so a fuzz failure reproduces exactly from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x1_0000_0000
  }
}

/** Feed a whole stream through one tail and report what a caller would see. */
function feed(
  chunks: readonly string[],
  limit?: number,
): { tail: Tail; text: string; all: string } {
  const tail = createTail()
  let all = ''
  for (const c of chunks) {
    all += c
    if (limit === undefined) appendTail(tail, c)
    else appendTail(tail, c, limit)
  }
  return { tail, text: tailText(tail), all }
}

describe('createTail — one independent buffer per stream', () => {
  it('starts empty, and starts HONEST (dropped 0 means nothing lost)', () => {
    const t = createTail()
    expect(t).toEqual({ chunks: [], chars: 0, dropped: 0 })
    expect(tailText(t)).toBe('')
  })

  // logger.ts allocates four of these per persistent task (out/err × pre-ready
  // at taskStart, then a fresh pair post-ready at taskComplete) and keys them
  // in a Map by node id. A module-level singleton — the obvious "why allocate?"
  // simplification — would merge two dev servers' logs into one block and
  // double-count their dropped counters.
  it('returns a distinct object, with distinct chunk arrays, every call', () => {
    const a = createTail()
    const b = createTail()
    expect(a).not.toBe(b)
    expect(a.chunks).not.toBe(b.chunks)
    appendTail(a, 'server-a', 100)
    expect(tailText(b)).toBe('')
    expect(b.chars).toBe(0)
  })
})

describe('appendTail — under and at the cap', () => {
  it('retains everything below the cap and reports nothing dropped', () => {
    const { tail, text } = feed(['one ', 'two ', 'three'], 100)
    expect(text).toBe('one two three')
    expect({ chars: tail.chars, dropped: tail.dropped }).toEqual({ chars: 13, dropped: 0 })
  })

  // The guard is `chars > limit`, so landing EXACTLY on the cap must keep
  // everything. A `>=` here would evict a chunk from a tail that fits, and
  // stamp `dropped` on a log that lost nothing — property 2, inverted.
  it('retains everything at EXACTLY the cap', () => {
    const { tail, text } = feed(['a'.repeat(10)], 10)
    expect(text).toBe('a'.repeat(10))
    expect({ chars: tail.chars, dropped: tail.dropped }).toEqual({ chars: 10, dropped: 0 })
  })

  it('evicts as soon as one character goes over', () => {
    const exact = feed(['a'.repeat(5), 'b'.repeat(5)], 10)
    expect(exact.tail.dropped).toBe(0)
    const over = feed(['a'.repeat(5), 'b'.repeat(6)], 10)
    expect(over.tail.dropped).toBe(5)
    expect(over.text).toBe('b'.repeat(6))
  })

  // A stream can hand over empty strings (a decoder flush with nothing
  // pending — `runner.ts:523` guards that one, but nothing in the contract
  // says a caller must). Pushing them would grow `chunks` without bound while
  // `chars` stayed put, so the `chars > limit` eviction could never reclaim
  // them: an unbounded array behind a bounded character count.
  it('treats an empty chunk as a no-op, pushing no phantom entry', () => {
    const t = createTail()
    appendTail(t, '', 10)
    expect(t).toEqual({ chunks: [], chars: 0, dropped: 0 })
  })

  it('stays flat across a flood of empty chunks', () => {
    const t = createTail()
    for (let i = 0; i < 10_000; i++) appendTail(t, '', 10)
    expect({ entries: t.chunks.length, chars: t.chars, dropped: t.dropped }).toEqual({
      entries: 0,
      chars: 0,
      dropped: 0,
    })
  })

  it('interleaves empty chunks with real ones without disturbing the text', () => {
    const { tail, text } = feed(['', 'a', '', 'b', '', ''], 100)
    expect(text).toBe('ab')
    expect({ entries: tail.chunks.length, dropped: tail.dropped }).toEqual({
      entries: 2,
      dropped: 0,
    })
  })
})

describe('appendTail — whole-chunk head eviction (the documented design)', () => {
  // The load-bearing half of property 3. Three 100-char chunks under a 250 cap
  // go 1 char over on the third, and the whole 100-char HEAD leaves — not the
  // 50 characters that would have been enough. A "trim exactly what overflows"
  // rewrite would have to slice mid-chunk on every append, which is the
  // per-chunk copy this design exists to avoid.
  it('evicts an entire head chunk, never a partial one', () => {
    const { tail, text } = feed(['A'.repeat(100), 'B'.repeat(100), 'C'.repeat(100)], 250)
    expect(tail.chunks).toEqual(['B'.repeat(100), 'C'.repeat(100)])
    expect(text).toBe('B'.repeat(100) + 'C'.repeat(100))
    expect({ chars: tail.chars, dropped: tail.dropped }).toEqual({ chars: 200, dropped: 100 })
  })

  // The consequence, stated so it is a decision rather than a surprise: under
  // whole-chunk eviction a tail routinely holds well under its cap. Measured
  // across 2000 random streams the worst case retained 3% of the cap. The
  // guarantee is an UPPER bound on memory, never a lower bound on context.
  it('may retain far less than the cap — the price of not splitting chunks', () => {
    const { tail } = feed([...Array.from({ length: 9 }, () => 'x'.repeat(11))], 100)
    // 9×11 = 99 fits; a 10th would evict a whole 11 leaving 88.
    expect(tail.chars).toBe(99)
    const { tail: after } = feed([...Array.from({ length: 10 }, () => 'x'.repeat(11))], 100)
    expect(after.chars).toBe(99)
    expect(after.chars).toBeLessThan(100)
  })

  // Eviction must not re-split what it keeps: the retained text is always a
  // join of whole trailing chunks, so a chunk that survives survives INTACT.
  // This is what lets the logger hand `tailText` straight to a renderer
  // without worrying that a line was cut in the middle.
  it('leaves every surviving chunk byte-identical to the one appended', () => {
    const chunks = ['alpha\n', 'beta\n', 'gamma\n', 'delta\n', 'epsilon\n']
    const { tail } = feed(chunks, 20)
    // Whatever survived must appear verbatim in the original list, in order.
    const kept = tail.chunks
    const start = chunks.length - kept.length
    expect(kept).toEqual(chunks.slice(start))
    expect(tail.dropped).toBe(chunks.slice(0, start).join('').length)
  })

  it('keeps the dropped counter exact across many evictions', () => {
    const chunks = Array.from({ length: 200 }, (_, i) => `line-${i}\n`)
    const { tail, text, all } = feed(chunks, 50)
    expect(tail.chars + tail.dropped).toBe(all.length)
    expect(all.endsWith(text)).toBe(true)
    expect(tail.dropped).toBe(all.length - text.length)
    expect(tail.dropped).toBeGreaterThan(0)
  })

  // One append can overflow by more than one chunk's worth, so the eviction
  // is a WHILE loop, not an `if`. A single-step version would leave the tail
  // permanently over its cap here — the bound silently stops holding.
  it('evicts as many head chunks as one oversized append requires', () => {
    const t = createTail()
    appendTail(t, 'a'.repeat(10), 100)
    appendTail(t, 'b'.repeat(10), 100)
    appendTail(t, 'c'.repeat(10), 100)
    appendTail(t, 'd'.repeat(95), 100)
    expect(t.chars).toBeLessThanOrEqual(100)
    expect(t.chunks).toEqual(['d'.repeat(95)])
    expect(t.dropped).toBe(30)
  })
})

describe('appendTail — a single chunk larger than the whole cap', () => {
  // Not a theoretical shape. Measured against a real `Bun.spawn` child writing
  // 5 MiB: the decoder handed back chunks of 262144 characters — 4× the
  // shipped 64 KiB cap — so this branch runs in production, and it is the one
  // place the module copies.
  it('keeps the LAST `limit` characters of an oversized lone chunk', () => {
    const { tail, text } = feed(['abcdefghij'], 4)
    expect(text).toBe('ghij')
    expect({ chars: tail.chars, dropped: tail.dropped }).toEqual({ chars: 4, dropped: 6 })
  })

  // The `chunks.length > 1` guard on the while loop is what makes this work:
  // without it the loop would shift the sole chunk away and the tail would
  // retain NOTHING (chars 0, the whole chunk dropped) instead of its last
  // `limit` characters — the newest output, which is the only part worth
  // keeping, thrown away precisely when a task is at its chattiest.
  it('retains the newest output rather than emptying itself', () => {
    const { tail, text } = feed(['x'.repeat(1000) + 'NEWEST'], 6)
    expect(text).toBe('NEWEST')
    expect(tail.chars).toBe(6)
    expect(tail.dropped).toBe(1000)
  })

  it('shifts the head THEN slices when an oversized chunk lands on a populated tail', () => {
    const t = createTail()
    appendTail(t, 'old'.repeat(10), 50) // 30 chars, fits
    appendTail(t, 'z'.repeat(200), 50)
    expect(t.chunks).toEqual(['z'.repeat(50)])
    expect(t.chars).toBe(50)
    // Everything appended (30 + 200) minus what is retained (50).
    expect(t.dropped).toBe(180)
  })

  it('stays bounded under a burst of back-to-back oversized chunks', () => {
    const t = createTail()
    for (let i = 0; i < 50; i++) appendTail(t, String(i).padStart(4, '0').repeat(2000), 100)
    expect(t.chars).toBe(100)
    expect(t.chunks).toHaveLength(1)
    expect(t.dropped).toBe(50 * 8000 - 100)
  })

  // The realistic production shape at the SHIPPED cap, with no `limit`
  // override: a 256 KiB burst must land at 64 KiB, not at 256 KiB.
  it('bounds a production-sized burst at the default cap', () => {
    const t = createTail()
    appendTail(t, 'q'.repeat(262_144))
    expect(t.chars).toBe(PERSISTENT_TAIL_CHARS)
    expect(t.dropped).toBe(262_144 - PERSISTENT_TAIL_CHARS)
    expect(tailText(t)).toHaveLength(PERSISTENT_TAIL_CHARS)
  })
})

describe('appendTail — the bound holds (property 1)', () => {
  // The single most important assertion in the file: whatever a task writes,
  // in whatever chunking, the retained size never exceeds the cap. This is
  // the F10 heap leak, stated as a test.
  it('never exceeds the limit, across every chunk shape', () => {
    const shapes: Array<{ why: string; chunks: string[] }> = [
      { why: 'one huge chunk', chunks: ['x'.repeat(5000)] },
      { why: 'many tiny chunks', chunks: Array.from({ length: 5000 }, () => 'x') },
      { why: 'a tiny chunk then a huge one', chunks: ['x', 'y'.repeat(5000)] },
      { why: 'a huge chunk then a tiny one', chunks: ['x'.repeat(5000), 'y'] },
      {
        why: 'alternating sizes',
        chunks: Array.from({ length: 300 }, (_, i) => 'x'.repeat(i % 40)),
      },
      { why: 'exact-cap chunks', chunks: Array.from({ length: 20 }, () => 'x'.repeat(64)) },
      { why: 'cap+1 chunks', chunks: Array.from({ length: 20 }, () => 'x'.repeat(65)) },
      { why: 'empties among giants', chunks: ['', 'x'.repeat(900), '', '', 'y'.repeat(900), ''] },
    ]
    for (const { why, chunks } of shapes) {
      const { tail, text } = feed(chunks, 64)
      expect({ why, over: tail.chars > 64 }).toEqual({ why, over: false })
      expect({ why, textOver: text.length > 64 }).toEqual({ why, textOver: false })
    }
  })

  // `chars` is maintained incrementally by every branch; if it ever drifts
  // from the real text the bound is enforced against a fiction. Pinned
  // separately from the fuzz because the two are different failures: drift
  // means the cap is measured wrong, over-cap means it is applied wrong.
  it('keeps `chars` equal to the length of the text it would render', () => {
    for (const limit of [1, 2, 7, 64, 1000]) {
      const { tail, text } = feed(
        Array.from({ length: 100 }, (_, i) => 'ab'.repeat(i % 13)),
        limit,
      )
      expect({ limit, chars: tail.chars }).toEqual({ limit, chars: text.length })
    }
  })

  // Properties 1, 2 and 4 at once, over 3000 pseudo-random streams. Any one of
  // them failing is a distinct real defect: a blown bound is the heap leak, a
  // broken conservation means dropped lies, a non-suffix means the retained
  // text is not the newest output the reader is promised.
  it('fuzz: bound, conservation and suffix hold together', () => {
    const rand = rng(0x7a11_c0de)
    const alphabet = 'abcdefghijklmnopqrstuvwxyz\n'
    for (let trial = 0; trial < 3000; trial++) {
      const limit = 1 + Math.floor(rand() * 40)
      const t = createTail()
      let all = ''
      const n = Math.floor(rand() * 14)
      for (let i = 0; i < n; i++) {
        const len = Math.floor(rand() * 60)
        let chunk = ''
        for (let j = 0; j < len; j++) chunk += alphabet[Math.floor(rand() * alphabet.length)]
        all += chunk
        appendTail(t, chunk, limit)
      }
      const text = tailText(t)
      // One object comparison so a failure prints the whole state, not just
      // the first boolean that tripped.
      expect({
        trial,
        limit,
        withinBound: t.chars <= limit,
        charsMatchText: t.chars === text.length,
        conserved: t.chars + t.dropped === all.length,
        isSuffix: all.endsWith(text),
      }).toEqual({
        trial,
        limit,
        withinBound: true,
        charsMatchText: true,
        conserved: true,
        isSuffix: true,
      })
    }
  })
})

describe('a capped tail can never read as complete (property 2)', () => {
  // The invariant `framed-output.ts` renders. `pushStreamSection` prints the
  // "… N earlier characters dropped" notice if and only if `dropped > 0`, so
  // any drift between "text was lost" and "dropped > 0" is a log that lies to
  // the reader in one direction or the other.
  it('reports dropped > 0 exactly when text was lost — both directions', () => {
    const rand = rng(0x0dd_b0a7)
    for (let trial = 0; trial < 2000; trial++) {
      const limit = 1 + Math.floor(rand() * 25)
      const t = createTail()
      let all = ''
      const n = Math.floor(rand() * 10)
      for (let i = 0; i < n; i++) {
        const chunk = 'z'.repeat(Math.floor(rand() * 40))
        all += chunk
        appendTail(t, chunk, limit)
      }
      const complete = tailText(t) === all
      expect({ trial, complete, claimsComplete: t.dropped === 0 }).toEqual({
        trial,
        complete,
        claimsComplete: complete,
      })
    }
  })

  it('never inflates dropped for a stream that fit', () => {
    const { tail } = feed(['a', 'b', '', 'c'], 1000)
    expect(tail.dropped).toBe(0)
  })

  // A tail whose slice left an empty first entry (limit 0, below) later has
  // that empty string evicted. Adding its zero length to `dropped` is
  // harmless, but an implementation that counted ENTRIES rather than
  // characters would report a drop where nothing was lost.
  it('counts characters, not evictions, so a zero-length eviction adds nothing', () => {
    const t = createTail()
    appendTail(t, 'abc', 0) // leaves chunks: ['']
    const afterSlice = t.dropped
    appendTail(t, 'de', 5) // evicts the '' head
    expect(t.dropped).toBe(afterSlice + 0 + 0)
    expect(t.dropped).toBe(3)
  })
})

/**
 * `String.prototype.isWellFormed` (ES2024) hand-rolled.
 *
 * Bun HAS the built-in, but the repo's tsconfig `lib` predates it, so calling
 * it is five TS2550s under `oxlint --type-aware`. Reimplemented here rather
 * than bumping `lib` repo-wide for one test file's convenience.
 *
 * Well-formed means every surrogate is paired: a high surrogate (D800-DBFF)
 * must be followed by a low one (DC00-DFFF), and a low surrogate may never
 * appear alone. A lone surrogate is exactly what splitting a chunk mid-emoji
 * would leave behind.
 */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

describe('appendTail — unicode at the cap boundary', () => {
  // Whole-chunk eviction is inherently safe for multi-byte text: chunks come
  // out of a streaming TextDecoder, so each one is already well-formed, and
  // evicting whole ones can never cut inside a character. This is the common
  // path and it must stay clean.
  it('never mangles multi-byte text under whole-chunk eviction', () => {
    const { tail, text } = feed(['😀😀😀', '日本語です', '🎉🎉'], 8)
    expect(isWellFormed(text)).toBe(true)
    expect(text).toBe('🎉🎉')
    // '😀😀😀' is 6 UTF-16 units, '日本語です' is 5 — both evicted whole.
    expect(tail.dropped).toBe(11)
  })

  it('keeps astral characters intact when everything fits', () => {
    const { text } = feed(['✅ ready in ', '1.2s 🚀'], 100)
    expect(text).toBe('✅ ready in 1.2s 🚀')
    expect(isWellFormed(text)).toBe(true)
  })

  // FINDING (src/util/tail.ts:49). The single-chunk slice cuts by UTF-16 code
  // UNIT, so a cut landing inside a surrogate pair leaves a LONE SURROGATE at
  // the head of the retained text — `isWellFormed()` is false and a terminal
  // renders U+FFFD. Reachable: a real spawned child hands over 262144-char
  // chunks (4× the cap), and dev-server banners are full of emoji. Cosmetic
  // only — the block already announces the truncation right above it — so
  // this is pinned as CURRENT behaviour rather than worked around.
  it('DOES split a surrogate pair when the slice path cuts one (documented defect)', () => {
    const { tail, text } = feed(['😀😀'], 3) // 4 code units, cut at 1
    expect(isWellFormed(text)).toBe(false)
    expect(text.charCodeAt(0)).toBe(0xde00) // a lone LOW surrogate
    expect(tail.dropped).toBe(1)
    // The fix, if it is ever wanted, is to nudge the cut off a low surrogate.
    expect(isWellFormed(text.slice(1))).toBe(true)
  })

  it('the whole-chunk path stays well-formed where the slice path does not', () => {
    // Same characters, same cap — only the chunking differs. Proves the defect
    // above belongs to the slice, not to bounded capture in general.
    expect(isWellFormed(feed(['😀', '😀'], 3).text)).toBe(true)
    expect(isWellFormed(feed(['😀😀'], 3).text)).toBe(false)
  })

  // FINDING (low): `dropped` counts UTF-16 code units, while
  // framed-output.ts:142 renders it as "N earlier characters dropped". For
  // astral text the printed number is up to 2× the characters a reader can
  // count. Pinned as current behaviour so the units are a decision.
  it('counts dropped in UTF-16 code units, not user-visible characters', () => {
    const { tail } = feed(['😀😀😀', 'tail'], 4)
    expect(tail.dropped).toBe(6) // three emoji, reported as six
    // `Array.from` rather than spread: identical code-point semantics, but
    // oxlint's no-misused-spread flags string spread on sight, and here the
    // code-point split IS the point being made rather than a mistake.
    expect(Array.from('😀😀😀')).toHaveLength(3)
  })

  // A combining mark can be separated from its base by the slice, leaving an
  // orphaned accent. Unlike the surrogate case the result is still WELL-FORMED
  // text — every character-based cap has this property and there is nothing to
  // fix — so it is recorded only so it is not mistaken for the defect above.
  // Written with explicit escapes because a literal accented character in
  // source may be precomposed (1 code unit) or decomposed (2), which silently
  // changes which branch the case exercises.
  it('may separate a combining mark from its base, which is still well-formed', () => {
    const { text } = feed(['e\u0301x'], 2) // decomposed: 3 code units, cut at 1
    expect(isWellFormed(text)).toBe(true)
    expect(text).toBe('\u0301x') // the accent outlived its base
  })

  // The PRECOMPOSED spelling of the same text is one code unit per character,
  // so it fits under the same cap untouched — proof the case above is about
  // where the cut lands, not about accented text being mishandled.
  it('leaves the precomposed spelling of the same text alone under that cap', () => {
    const { tail, text } = feed(['\u00e9x'], 2)
    expect(text).toBe('\u00e9x')
    expect(tail.dropped).toBe(0)
  })
})

describe('appendTail — hostile limits', () => {
  // A zero cap must retain nothing while still accounting for everything —
  // the degenerate end of the bound, and the cheapest way to drive the
  // "everything was dropped" rendering path.
  it('retains nothing at limit 0 but keeps counting honestly', () => {
    const t = createTail()
    appendTail(t, 'abc', 0)
    expect({ text: tailText(t), chars: t.chars, dropped: t.dropped }).toEqual({
      text: '',
      chars: 0,
      dropped: 3,
    })
    appendTail(t, 'de', 0)
    expect({ text: tailText(t), chars: t.chars, dropped: t.dropped }).toEqual({
      text: '',
      chars: 0,
      dropped: 5,
    })
  })

  // The slice leaves an empty string in `chunks` rather than emptying the
  // array, so `chunks.length` is 1 while `chars` is 0. Harmless (tailText
  // takes its single-chunk fast path and returns ''), and pinned only so the
  // discrepancy is not read as corruption by a future maintainer.
  it('leaves a single empty entry behind at limit 0, not an empty array', () => {
    const t = createTail()
    appendTail(t, 'abc', 0)
    expect(t.chunks).toEqual([''])
    expect(tailText(t)).toBe('')
  })

  it('degrades a negative limit to the same "retain nothing" behaviour', () => {
    const t = createTail()
    appendTail(t, 'abc', -5)
    expect({ text: tailText(t), chars: t.chars, dropped: t.dropped }).toEqual({
      text: '',
      chars: 0,
      dropped: 3,
    })
  })

  // FINDING (latent, src/util/tail.ts:41+47). Every bound test is `chars >
  // limit`, and any comparison against NaN is false — so a non-finite limit
  // disables the cap ENTIRELY and silently, which is precisely the unbounded
  // heap this module exists to prevent. Unreachable today (the sole holder
  // always takes the default), but nothing guards it.
  it('a NaN limit silently disables the bound (documented defect)', () => {
    const t = createTail()
    for (let i = 0; i < 500; i++) appendTail(t, 'x'.repeat(100), Number.NaN)
    expect(t.chars).toBe(50_000)
    expect(t.dropped).toBe(0)
  })

  it('an Infinite limit is unbounded too, which at least reads as intentional', () => {
    const t = createTail()
    for (let i = 0; i < 100; i++) appendTail(t, 'x'.repeat(100), Number.POSITIVE_INFINITY)
    expect(t.chars).toBe(10_000)
    expect(t.dropped).toBe(0)
  })

  // FINDING (latent). The cap is a per-call ARGUMENT, not state on the Tail,
  // so nothing makes successive appends agree. A tail bounded once at 10 grows
  // straight back past it on the next default-limit call. Benign while there
  // is one holder passing one value, but the header comment explicitly invites
  // "a future second holder" — at which point two callers sharing a tail would
  // each quietly undo the other's bound.
  it('does not remember its limit between calls (documented defect)', () => {
    const t = createTail()
    appendTail(t, 'x'.repeat(50), 10)
    expect(t.chars).toBe(10)
    appendTail(t, 'y'.repeat(50)) // default 64 KiB
    expect(t.chars).toBe(60)
    expect(t.chars).toBeGreaterThan(10)
  })

  // The other direction is safe: tightening the limit reclaims immediately,
  // so a shrinking cap is enforced on the very next append.
  it('applies a newly tightened limit on the next append', () => {
    const t = createTail()
    appendTail(t, 'a'.repeat(40), 1000)
    appendTail(t, 'b'.repeat(5), 10)
    expect(t.chars).toBeLessThanOrEqual(10)
    expect(t.chunks).toEqual(['b'.repeat(5)])
  })
})

describe('tailText — a snapshot, never a live view', () => {
  it('is empty for a fresh tail', () => {
    expect(tailText(createTail())).toBe('')
  })

  // Reading must not consume. `logger.ts:500` reads the pre-ready tail at
  // taskComplete, and `logger.ts:441` reads post-ready tails at runEnd — which
  // run() calls TWICE on the success path. A `takeChunks`-style destructive
  // read (the sibling helper in the same file behaves that way, which is
  // exactly how this could be "simplified" wrongly) would blank the second.
  it('is idempotent — reading does not consume the buffer', () => {
    const { tail } = feed(['one', 'two'], 100)
    expect(tailText(tail)).toBe('onetwo')
    expect(tailText(tail)).toBe('onetwo')
    expect(tailText(tail)).toBe('onetwo')
    expect(tail.chars).toBe(6)
    expect(tail.chunks).toHaveLength(2)
  })

  // A kept-alive child keeps writing between run()'s two runEnd calls, so a
  // previously-returned string must not mutate under the caller.
  it('returns a snapshot unaffected by later appends', () => {
    const t = createTail()
    appendTail(t, 'before', 100)
    const snapshot = tailText(t)
    appendTail(t, '-after', 100)
    expect(snapshot).toBe('before')
    expect(tailText(t)).toBe('before-after')
  })

  // logger.ts runEnd emits every block in one loop and resets every tail in a
  // SEPARATE loop afterwards. That ordering is only safe because the emitted
  // text is already detached from the tail.
  it('returns a snapshot unaffected by a later resetTail', () => {
    const { tail } = feed(['kept'], 100)
    const snapshot = tailText(tail)
    resetTail(tail)
    expect(snapshot).toBe('kept')
    expect(tailText(tail)).toBe('')
  })

  // The `length === 1` fast path skips `join('')`. Both arms must produce
  // identical text, or a single-chunk tail would render differently from a
  // multi-chunk one carrying the same bytes.
  it('the single-chunk fast path matches the join path exactly', () => {
    const single = feed(['hello world'], 100)
    const split = feed(['hello', ' ', 'world'], 100)
    expect(single.tail.chunks).toHaveLength(1)
    expect(split.tail.chunks).toHaveLength(3)
    expect(single.text).toBe(split.text)
  })

  it('joins with no separator, so chunk boundaries leave no trace', () => {
    const { text } = feed(['par', 'tial ', 'li', 'ne\n'], 100)
    expect(text).toBe('partial line\n')
  })

  it('keeps accumulating after a read', () => {
    const t = createTail()
    appendTail(t, 'a', 100)
    expect(tailText(t)).toBe('a')
    appendTail(t, 'b', 100)
    appendTail(t, 'c', 100)
    expect(tailText(t)).toBe('abc')
    expect(t.dropped).toBe(0)
  })

  // Reading must not disturb the bound either — a read between appends must
  // leave eviction behaving exactly as if nothing had been read.
  it('reading mid-stream does not change what gets evicted', () => {
    const chunks = ['aaa', 'bbb', 'ccc', 'ddd']
    const quiet = feed(chunks, 6)
    const noisy = createTail()
    for (const c of chunks) {
      appendTail(noisy, c, 6)
      tailText(noisy)
    }
    expect(tailText(noisy)).toBe(quiet.text)
    expect(noisy.dropped).toBe(quiet.tail.dropped)
  })
})

describe('resetTail — starting a clean phase on the same object', () => {
  // logger.ts holds tails in a Map and resets them in place; returning a new
  // object instead would leave the Map pointing at the old, still-growing one.
  it('clears in place, keeping the caller’s object identity', () => {
    const { tail } = feed(['x'.repeat(50)], 10)
    const chunksRef = tail.chunks
    expect(tail.dropped).toBeGreaterThan(0)
    resetTail(tail)
    expect(tail).toEqual({ chunks: [], chars: 0, dropped: 0 })
    expect(tail.chunks).toBe(chunksRef)
  })

  // Resetting `dropped` is correct, not a loss of information: the new phase
  // has genuinely lost nothing yet, and leaving a stale count would make the
  // post-ready block claim a truncation belonging to the pre-ready window.
  it('makes the tail read as complete again, honestly', () => {
    const { tail } = feed(['x'.repeat(500)], 10)
    resetTail(tail)
    expect(tail.dropped).toBe(0)
    expect(tailText(tail)).toBe('')
    appendTail(tail, 'fresh', 10)
    expect({ text: tailText(tail), dropped: tail.dropped }).toEqual({
      text: 'fresh',
      dropped: 0,
    })
  })

  it('leaves a reset tail behaving exactly like a brand-new one', () => {
    const reused = createTail()
    for (const c of ['junk', 'more junk', 'x'.repeat(200)]) appendTail(reused, c, 16)
    resetTail(reused)
    const fresh = createTail()
    const stream = ['alpha', 'beta', 'gamma', 'delta']
    for (const c of stream) {
      appendTail(reused, c, 8)
      appendTail(fresh, c, 8)
    }
    expect(reused).toEqual(fresh)
  })

  it('is idempotent and safe on an already-empty tail', () => {
    const t = createTail()
    resetTail(t)
    resetTail(t)
    expect(t).toEqual({ chunks: [], chars: 0, dropped: 0 })
  })
})

describe('call-site contracts', () => {
  // logger.ts imports from '../util/index.js'; a barrel exporting different
  // symbols would make every test above vacuous for the path that ships.
  it('the barrel re-exports the very same functions production imports', () => {
    expect(appendViaBarrel).toBe(appendTail)
    expect(createViaBarrel).toBe(createTail)
    expect(tailTextViaBarrel).toBe(tailText)
    expect(resetViaBarrel).toBe(resetTail)
  })

  // The cap CLAUDE.md and docs quote as "64 KiB". A silent change to it moves
  // both a memory bound and how much context a user gets on a failing server.
  it('the shipped cap is 64 KiB', () => {
    expect(PERSISTENT_TAIL_CHARS).toBe(65_536)
    expect(PERSISTENT_TAIL_CHARS).toBe(64 * 1024)
  })

  // Every appendTail call in logger.ts (:473, :489) omits the third argument,
  // so the DEFAULT is the bound that actually ships — a test suite that only
  // ever passed explicit small limits would not notice the default breaking.
  it('bounds at the default when the limit argument is omitted', () => {
    const t = createTail()
    for (let i = 0; i < 40; i++) appendTail(t, 'y'.repeat(10_000))
    expect(t.chars).toBeLessThanOrEqual(PERSISTENT_TAIL_CHARS)
    expect(t.dropped).toBe(400_000 - t.chars)
    expect(tailText(t)).toHaveLength(t.chars)
  })

  // The full sequence logger.ts drives, without importing the logger: a
  // persistent task capped pre-ready, drained at taskComplete, given a fresh
  // pair of tails post-ready, then drained and reset at runEnd — which run()
  // calls twice while the child is still writing.
  it('survives the logger’s pre-ready → ready → runEnd lifecycle', () => {
    // taskStart: one tail per stream.
    const preOut = createTail()
    const preErr = createTail()
    appendTail(preOut, 'boot '.repeat(30_000)) // 150k chars, well over the cap
    appendTail(preErr, 'warn: deprecated\n')

    // taskComplete reads both, plus the dropped counters, directly.
    const preStdout = tailText(preOut)
    const dropped = { stdout: preOut.dropped, stderr: preErr.dropped }
    expect(preStdout).toHaveLength(PERSISTENT_TAIL_CHARS)
    expect(dropped.stdout).toBeGreaterThan(0) // the block must announce this
    expect(dropped.stderr).toBe(0) // …and must not claim a drop that never happened

    // The pre-ready pair is dropped from the Map; a fresh pair takes over.
    const postOut = createTail()
    expect(postOut.dropped).toBe(0)
    appendTail(postOut, 'GET /  200\n')

    // runEnd #1: read, then reset in a separate pass.
    const firstFlush = tailText(postOut)
    resetTail(postOut)
    // The child keeps writing between run()'s two runEnd calls.
    appendTail(postOut, 'GET /favicon 404\n')
    expect(firstFlush).toBe('GET /  200\n') // the emitted text is detached
    expect(tailText(postOut)).toBe('GET /favicon 404\n')
  })

  // Eviction uses Array.prototype.shift(), which is the obvious thing to
  // "optimise" away. Measured on this box: 200k appends of a 1-char chunk —
  // the worst shape, 65536 buffered entries, one shift per append — take
  // ~15ms, i.e. shift is amortised O(1) here. A rewrite to `chunks.slice(1)`
  // or a per-append `join`/concat is O(n) per append and blows this budget by
  // orders of magnitude, which is the regression worth catching; the bound is
  // deliberately ~100× the measurement so it can never flake on load.
  it('keeps eviction linear at the shipped cap', () => {
    const t = createTail()
    const started = Bun.nanoseconds()
    for (let i = 0; i < 200_000; i++) appendTail(t, 'x')
    const ms = (Bun.nanoseconds() - started) / 1e6
    expect(t.chars).toBe(PERSISTENT_TAIL_CHARS)
    expect(t.chunks).toHaveLength(PERSISTENT_TAIL_CHARS)
    expect(ms).toBeLessThan(1500 * PERF_SCALE)
  }, 30_000)
})
