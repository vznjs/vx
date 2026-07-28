import { describe, expect, it } from 'bun:test'
import { parseRunArgs, parsePruneArgs } from '../src/cli/index.js'
import { parseSize } from '../src/util/size.js'
// Every cross-module caller reaches parseSize through the util CONTRACT
// (tests/module-boundaries.test.ts): orchestrator/resources.ts:9,
// workspace/project-loader.ts:3, cli/run.ts:30, cli/cache.ts:2. The barrel
// re-export is part of the surface under test, not an implementation detail.
import { parseSize as parseSizeViaBarrel } from '../src/util/index.js'

// parseSize is the single gate on every byte quantity a user can type:
//
//   `vx cache prune --max-size <size>`  → the LRU eviction cap. A value
//        larger than intended evicts nothing.
//   `vx run --memory <size>`            → the memory BUDGET that every
//        `exec.resources.memory: "<n>%"` reservation resolves against
//        (orchestrator/resources.ts:35). A wrong budget silently mis-sizes
//        every percent reservation in the graph, so the scheduler admits the
//        wrong set of tasks concurrently — no error, just wrong packing.
//   `exec.resources.memory: "512MB"`    → validated by the loader as
//        `parseSize(memory) !== null` (workspace/project-loader.ts:627) and
//        then resolved by `parseSize(v) ?? 0` (resources.ts:36). Those two
//        must agree: anything the loader admits must resolve to a real
//        number, or a declared reservation silently becomes "reserve nothing".
//
// Both directions are load-bearing. A wrong ACCEPT is a budget the user did
// not ask for; a wrong REJECT is a confusing flag error on a legal
// invocation. Neither may throw — this sits directly on argv.
//
// Every rejection row below was checked against a mutated copy of size.ts: a
// row no plausible mutation can flip is a false guarantee, and those were
// pruned rather than kept for volume (whitespace-only strings, lone
// surrogates and non-ASCII digits all stay null under every rewrite, because
// `\d+` needs at least one ASCII digit no matter how the rest is relaxed).

const KiB = 1024
const MiB = 1024 ** 2
const GiB = 1024 ** 3
const TiB = 1024 ** 4

/** Assert null while naming the offending input in the failure diff. */
function rejects(raw: string, why?: string): void {
  expect({ raw, why, got: parseSize(raw) }).toEqual({ raw, why, got: null })
}

describe('parseSize — accepted forms', () => {
  it('parses a bare integer as bytes', () => {
    expect(parseSize('0')).toBe(0)
    expect(parseSize('1')).toBe(1)
    expect(parseSize('512')).toBe(512)
    expect(parseSize('1048576')).toBe(1048576)
  })

  // The units are BINARY, matching docs/schema.md:203 ("powers of 1024") and
  // docs/cli.md's `8GB` / `512MB` examples. Literal expected values, not
  // `1024 ** n` expressions, so an SI (1000) rewrite cannot quietly satisfy
  // both sides of the assertion.
  it('scales K/M/G/T by powers of 1024, not 1000', () => {
    expect(parseSize('1K')).toBe(1024)
    expect(parseSize('1M')).toBe(1048576)
    expect(parseSize('1G')).toBe(1073741824)
    expect(parseSize('1T')).toBe(1099511627776)
  })

  it('multiplies the digits by the unit', () => {
    expect(parseSize('2K')).toBe(2 * KiB)
    expect(parseSize('512M')).toBe(512 * MiB)
    expect(parseSize('8G')).toBe(8 * GiB)
    expect(parseSize('2T')).toBe(2 * TiB)
  })

  // `B` is OPTIONAL and sits outside the unit group, so both spellings of
  // every unit must land on the same number. `--memory 8GB` and `--memory 8G`
  // are both documented; if they diverged, one of the two documented forms
  // would silently set a different budget.
  it('treats a trailing B as decoration, never as a multiplier', () => {
    expect(parseSize('1KB')).toBe(parseSize('1K'))
    expect(parseSize('1MB')).toBe(parseSize('1M'))
    expect(parseSize('1GB')).toBe(parseSize('1G'))
    expect(parseSize('1TB')).toBe(parseSize('1T'))
    expect(parseSize('512MB')).toBe(512 * MiB)
  })

  // With no unit letter the optional `B` still matches, so `4096B` is a legal
  // way to write bytes. Pinned because it is the one form where the capture
  // group is undefined AND the `B` is consumed — the branch a "require a unit
  // letter before B" tightening would silently drop.
  it('accepts a bare B as plain bytes', () => {
    expect(parseSize('1B')).toBe(1)
    expect(parseSize('4096B')).toBe(4096)
    expect(parseSize('0B')).toBe(0)
  })

  // A shell user writing `--max-size 007M` means seven. parseDecimalInt reads
  // leading zeros as decimal (never octal), and parseSize hands its `\d+`
  // capture straight over — so this must keep working.
  it('reads leading zeros as decimal', () => {
    expect(parseSize('007M')).toBe(7 * MiB)
    expect(parseSize('0512M')).toBe(512 * MiB)
    expect(parseSize('0000001K')).toBe(1024)
    expect(parseSize('000000')).toBe(0)
  })
})

// The `/i` flag and the `.toUpperCase()` on line 16 are a PAIR. `/i` lets `k`
// reach the switch, and only the uppercasing keeps it out of the final (T)
// branch — the exact bug cli/cache.ts:117 documents for its sibling
// parseDuration. Drop the uppercasing and `1k` becomes 1 TiB: a billion-fold
// budget error with no diagnostic.
describe('parseSize — case insensitivity', () => {
  const units: ReadonlyArray<readonly [string, number]> = [
    ['K', KiB],
    ['M', MiB],
    ['G', GiB],
    ['T', TiB],
  ]

  for (const [unit, mult] of units) {
    it(`parses 1${unit} identically in every casing, with and without B`, () => {
      const lower = unit.toLowerCase()
      expect(parseSize(`1${unit}`)).toBe(mult)
      expect(parseSize(`1${lower}`)).toBe(mult)
      expect(parseSize(`1${unit}B`)).toBe(mult)
      expect(parseSize(`1${unit}b`)).toBe(mult)
      expect(parseSize(`1${lower}B`)).toBe(mult)
      expect(parseSize(`1${lower}b`)).toBe(mult)
    })
  }

  // Stated separately from the matrix because this is the mis-routing itself:
  // a lowercase unit must land on ITS OWN multiplier, never fall through to
  // the switch's default arm.
  it('never routes a lowercase unit to the T (default) branch', () => {
    expect(parseSize('1k')).toBe(1024)
    expect(parseSize('1m')).toBe(1048576)
    expect(parseSize('1g')).toBe(1073741824)
    expect(parseSize('1k')).not.toBe(parseSize('1t'))
    expect(parseSize('1m')).not.toBe(parseSize('1t'))
    expect(parseSize('1g')).not.toBe(parseSize('1t'))
  })

  it('accepts a lowercase bare byte suffix', () => {
    expect(parseSize('1b')).toBe(1)
  })
})

describe('parseSize — zero', () => {
  // parseSize returns the NUMBER zero, not null: "0 bytes" is a well-formed
  // size, and refusing it here would make the error message "invalid size: 0"
  // instead of the accurate one the CLI prints.
  it('returns the number 0 for every zero spelling', () => {
    for (const raw of ['0', '00', '0B', '0K', '0M', '0G', '0T', '0GB', '0kb']) {
      expect({ raw, got: parseSize(raw) }).toEqual({ raw, got: 0 })
    }
  })

  // cli/cache.ts:58 tests `bytes === 0` and cli/run.ts:211 tests `bytes <= 0`.
  // Both are only sound because zero is a real 0 and never -0:
  // `Object.is(-0, 0)` is false, so a -0 would sail past the strict `=== 0`
  // guard and prune the entire cache.
  it('never returns negative zero', () => {
    expect(Object.is(parseSize('0'), -0)).toBe(false)
    expect(Object.is(parseSize('0GB'), -0)).toBe(false)
  })

  // The refusal of a zero bound lives at the CLI, NOT here — docs/cli.md:968
  // ("A zero bound is rejected") describes `vx cache prune`, and the same
  // string is a legal 0 for any other caller. Pinned in both directions so
  // the split stays a decision: moving the guard into parseSize would break
  // nothing visible here, but would change which layer owns the message.
  it('leaves the "0 wipes everything" refusal to the CLI callers', () => {
    expect(parseSize('0')).toBe(0)
    expect(parsePruneArgs(['--max-size', '0']).error).toMatch(/would evict every entry/)
    expect(parseRunArgs(['--memory', '0', 'build']).error).toMatch(/--memory must be/)
  })

  // The CLI guards the VALUE, not the literal string — so a computed-to-zero
  // `--max-size ${LIMIT}K` is refused too, not just a bare "0".
  it('makes the CLI zero guard fire for every zero spelling', () => {
    for (const raw of ['0', '0K', '0GB', '00']) {
      expect(parsePruneArgs(['--max-size', raw]).error).toMatch(/would evict every entry/)
      expect(parseRunArgs(['--memory', raw, 'build']).error).toMatch(/--memory must be/)
    }
  })
})

describe('parseSize — fractions are refused, never truncated', () => {
  // The docstring's own contract: fractional sizes are rejected outright.
  // Truncating `1.5GB` to 1GB would hand the scheduler a memory budget 33%
  // below what the user declared, and every percent reservation packing
  // against it would over-admit. Failing loud is the only safe arm.
  it('rejects every fractional spelling', () => {
    for (const raw of [
      '1.5GB',
      '1.5G',
      '0.5G',
      '.5G',
      '1.',
      '1.0G',
      '2.0',
      '1.5',
      '1.5K',
      '1.5MB',
    ]) {
      rejects(raw)
    }
  })

  // A "just parse it and floor" rewrite would satisfy the row above with a
  // number. This states the intent that row encodes: there is no fractional
  // input that yields a value at all.
  it('yields null, not a floored or rounded number', () => {
    expect(parseSize('1.9G')).toBeNull()
    expect(parseSize('1.9G')).not.toBe(GiB)
    expect(parseSize('1.9G')).not.toBe(2 * GiB)
  })

  // Both the loader gate and the resolver read the same null, so a fractional
  // declaration is a config ERROR rather than a silent "reserve nothing"
  // (resources.ts:36 turns null into 0).
  it('is what makes the loader refuse a fractional exec.resources.memory', () => {
    expect(parseSize('1.5GB')).toBeNull()
    expect(parseSize('1GB')).not.toBeNull()
  })
})

describe('parseSize — no whitespace anywhere', () => {
  // `^` and `$` bracket the whole pattern with no `\s*`, so the string must be
  // exactly the size. This matters because an unquoted `--memory 1 GB` arrives
  // as TWO argv entries: the parser sees "1" and then treats "GB" as a
  // positional task name. Accepting "1 GB" here would not fix that shell-level
  // split; it would only make a QUOTED "1 GB" mean 1 GiB while the unquoted
  // form meant 1 byte plus a bogus task name.
  it('rejects whitespace between the number and the unit, and at either end', () => {
    for (const raw of [
      '1 GB',
      '1 G',
      '1  G',
      '1\tG',
      '1\nG',
      ' 1G',
      '1G ',
      ' 1G ',
      '\t1G',
      '1G\t',
      '1G\n',
      '\n1G',
      '1G\r',
      '\r1G',
    ]) {
      rejects(raw)
    }
  })

  // Number() trims the full Unicode whitespace set, so a copy-pasted value
  // carrying an NBSP or a BOM reads as clean in a terminal — these are the
  // invisible inputs most likely to reach a size flag, and each must fail
  // loudly rather than resolve to something plausible.
  it('rejects invisible characters a terminal renders as nothing', () => {
    const invisible: ReadonlyArray<readonly [string, string]> = [
      ['1 GB', 'NBSP between number and unit'],
      [' 1GB', 'leading NBSP'],
      ['1GB ', 'trailing NBSP'],
      ['﻿1GB', 'BOM from a UTF-8-with-BOM file'],
      ['1​GB', 'zero-width space'],
      ['　1GB', 'ideographic space'],
      [' 1GB', 'U+2028 line separator'],
    ]
    for (const [raw, why] of invisible) rejects(raw, why)
  })
})

describe('parseSize — signs, units, and structural junk', () => {
  // A sign is unrepresentable: no caller has a use for a negative byte count,
  // and both CLI guards (`bytes <= 0`, `bytes === 0`) assume a non-negative
  // result. Widening the regex to `[+-]?\d+` would make `--max-size -1` a cap
  // no entry can ever be under.
  it('rejects a signed number, so the callers’ range guards hold', () => {
    for (const raw of ['-1', '-1G', '-0', '+1', '+1G']) rejects(raw)
  })

  // A unit with no number is the shape an unset shell var produces
  // (`--max-size ${LIMIT}G` → "G"). It must be an error, not a silent 1.
  it('rejects a unit with no number, and the empty string', () => {
    for (const raw of ['B', 'K', 'M', 'G', 'T', 'KB', 'GB', 'b', 'gb', '']) rejects(raw)
  })

  // Only K/M/G/T are units. P/E and the IEC spellings look right to a user and
  // must fail loudly rather than being read as some other unit.
  it('rejects unknown and IEC unit spellings', () => {
    for (const raw of [
      '1P',
      '1PB',
      '1E',
      '1EB',
      '1Z',
      '1KiB',
      '1MiB',
      '1Ki',
      '1i',
      '1kib',
      '1byte',
      '1bytes',
    ]) {
      rejects(raw)
    }
  })

  // Exactly one unit letter and at most one trailing B. Doubling or reordering
  // either is a typo, and each of these would otherwise have to pick a winner.
  it('rejects doubled, reordered, or leading unit letters', () => {
    for (const raw of ['1BB', '1KBB', '1KK', '1GG', '1KG', '1GK', '1KM', '1BK', '1BG', '1bb']) {
      rejects(raw)
    }
    for (const raw of ['B1', 'K1', 'G1G', 'GB1']) rejects(raw)
  })

  it('rejects separators a numeric literal would allow', () => {
    for (const raw of ['1_000', '1,000', '1_000K', "1'000"]) rejects(raw)
  })

  // resources.ts:34 and project-loader.ts:627 match `<n>%` with their OWN
  // regex before falling through to parseSize. If parseSize ever accepted a
  // `%` suffix, `50%` would resolve to 50 bytes on any path that reached
  // parseSize first.
  it('rejects a percent form — that is the caller’s vocabulary, not this one', () => {
    for (const raw of ['50%', '100%', '12.5%']) rejects(raw)
  })

  // Every row here is a value `Number()` converts to something
  // plausible-but-different. parseSize rejects them at the REGEX, before
  // parseDecimalInt is even reached — but the outcome must be the same null,
  // or `--memory 0x1000` would silently set a 4096-byte budget.
  const numberish: ReadonlyArray<readonly [string, number]> = [
    ['0x10', 16],
    ['0X10', 16],
    ['0b11', 3],
    ['0o17', 15],
    ['1e3', 1000],
    ['1E3', 1000],
    ['1e-3', 0.001],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ]

  for (const [raw, via] of numberish) {
    it(`rejects ${JSON.stringify(raw)} (Number() would make it ${via})`, () => {
      // The divergence this row guards must still exist.
      expect(Number(raw)).toBe(via)
      expect(parseSize(raw)).toBeNull()
    })
  }
})

describe('parseSize — the safe-integer ceiling', () => {
  // MAX_SAFE_INTEGER round-trips exactly and stays accepted; one past it is
  // where a typed digit stops surviving the parse, so parseDecimalInt refuses.
  // Without that guard `--max-size 9007199254740993` would set a cap of …92 —
  // a number the user never typed.
  it('accepts digits up to MAX_SAFE_INTEGER and rejects beyond', () => {
    expect(parseSize('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseSize('9007199254740992')).toBeNull()
    expect(parseSize('9007199254740993')).toBeNull()
    expect(parseSize('99999999999999999999')).toBeNull()
  })

  it('rejects a digit string long enough to overflow Number() to Infinity', () => {
    expect(Number('9'.repeat(400))).toBe(Number.POSITIVE_INFINITY)
    expect(parseSize('9'.repeat(400))).toBeNull()
    expect(parseSize('9'.repeat(400) + 'G')).toBeNull()
  })

  // The digit guard applies to the CAPTURE, so a suffixed value is checked
  // before multiplication.
  it('applies the digit ceiling to suffixed values too', () => {
    expect(parseSize('9007199254740991B')).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseSize('9007199254740992K')).toBeNull()
    expect(parseSize('99999999999999999999T')).toBeNull()
  })

  // size.ts guards the DIGITS (line 14) and never re-checks the PRODUCT. That
  // looks like a hole in the stated invariant ("digits past 2^53 parse to a
  // different number than the user typed") — it is not, and the reason is
  // worth pinning because it is a property of the multiplier TABLE, not of the
  // guard.
  //
  // Every multiplier is a power of two, so `n * mult` is a <=53-bit mantissa
  // shifted left: LOSSLESS. There is no rounded product to catch. Swap the
  // table to SI (1000-based) and that stops holding — MAX_SAFE_INTEGER * 1000
  // lands 24 short of the true product — so this asserts through BigInt, the
  // only arithmetic that can tell the two apart.
  it('multiplies EXACTLY, because every multiplier is a power of two', () => {
    const exactness: ReadonlyArray<readonly [string, bigint]> = [
      ['9007199254740991K', 1024n],
      ['9007199254740991M', 1024n ** 2n],
      ['9007199254740991G', 1024n ** 3n],
      ['9007199254740991T', 1024n ** 4n],
    ]
    for (const [raw, mult] of exactness) {
      const got = parseSize(raw)!
      expect(Number.isFinite(got)).toBe(true)
      expect(BigInt(got)).toBe(BigInt(Number.MAX_SAFE_INTEGER) * mult)
    }
  })

  // The other half of "no product guard needed": overflow to Infinity is
  // unreachable. The largest product any accepted input can produce is
  // MAX_SAFE_INTEGER * 2^40 ≈ 9.9e27, against a double's ~1.8e308 ceiling. An
  // Infinity here would defeat `bytes <= 0` and `bytes === 0` alike and reach
  // prune as a cap nothing can exceed.
  it('never overflows to Infinity for any input it accepts', () => {
    for (const raw of ['9007199254740991T', '9007199254740991G', '9007199254740991']) {
      const n = parseSize(raw)!
      expect(Number.isFinite(n)).toBe(true)
      expect(n).toBeGreaterThan(0)
    }
  })

  // Exact is not the same as SAFE. Past 2^53 the neighbouring integers are
  // unrepresentable, so `bytes + 1` would be a no-op — but no caller does
  // additive arithmetic on the result (prune compares `total > maxBytes`; the
  // memory budget is only ever multiplied by a percentage), so this records
  // the boundary rather than flagging it. 8192T is the shortest input across.
  it('leaves the safe-integer range at 8192T (2^53) while staying exact', () => {
    expect(parseSize('8191T')).toBe(8191 * TiB)
    expect(Number.isSafeInteger(parseSize('8191T')!)).toBe(true)

    expect(parseSize('8192T')).toBe(2 ** 53)
    expect(Number.isSafeInteger(parseSize('8192T')!)).toBe(false)
    expect(BigInt(parseSize('8192T')!)).toBe(8192n * 1024n ** 4n)
  })
})

describe('parseSize — hostile input', () => {
  // Rows kept only where a plausible rewrite (loosened anchors, tolerated
  // whitespace) actually flips the answer — a shell fragment that parsed as a
  // size would mean `--max-size "1G; rm -rf /"` silently became 1 GiB instead
  // of a flag error naming the value.
  it('returns null for shell fragments and trailing commands', () => {
    for (const raw of [
      '1 ',
      '1 G',
      '1G ',
      ' 1G',
      '1G rm -rf /',
      '1G;rm -rf /',
      '1G && echo pwned',
      '$(echo 1G)',
      '`echo 1G`',
      '1\ud800G',
      '\ud8001G',
      '1G'.repeat(5000),
    ]) {
      rejects(raw)
    }
  })

  // The pattern has no nested quantifier, so a long digit run that fails at
  // the last character backtracks linearly. A `(\d+)+` rewrite is the classic
  // way to break that, and it is catastrophic rather than merely slower:
  // measured 0.1ms here against 844ms for the nested form at n=40, growing
  // exponentially from there. The bound is ~1000x the healthy cost, so it
  // guards the algorithmic SHAPE and not machine speed.
  it('does not backtrack catastrophically on a long digit run', () => {
    const adversarial = '9'.repeat(40) + 'x'
    const started = Bun.nanoseconds()
    expect(parseSize(adversarial)).toBeNull()
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(100)
  })
})

describe('parseSize — anchoring', () => {
  // Without the `m` flag JS `$` matches only at end-of-input (unlike Perl,
  // where it also matches before a trailing newline). If `m` were ever added,
  // "1G\nrm -rf /" would parse as 1 GiB and the tail would be silently
  // discarded — and these values come from config files and CI env vars,
  // where a multi-line value is entirely reachable.
  it('anchors to the whole string, so a newline cannot smuggle a tail', () => {
    for (const raw of ['1G\nrm -rf /', 'rm -rf /\n1G', '1G\n2G', '1G\n', '\n1G']) rejects(raw)
  })

  it('rejects any trailing garbage after a valid size', () => {
    for (const raw of ['1G1', '1GB1', '512x', '1Gx', '1024!', '1G.']) rejects(raw)
  })
})

describe('call-site contracts', () => {
  // The forms documented for the two flags (docs/cli.md:188, :952, :979) and
  // for exec.resources.memory (docs/schema.md:203). Each must parse, or a
  // documented invocation is a flag error.
  it('parses every documented example', () => {
    const documented: ReadonlyArray<readonly [string, number]> = [
      ['8GB', 8 * GiB],
      ['512MB', 512 * MiB],
      ['2GB', 2 * GiB],
      ['500M', 500 * MiB],
      ['1G', GiB],
      ['1gb', GiB],
    ]
    for (const [raw, want] of documented) {
      expect({ raw, got: parseSize(raw) }).toEqual({ raw, got: want })
    }
  })

  // cli/run.ts:211 guards `bytes === null || bytes <= 0` and cli/cache.ts:57
  // guards `bytes === null` then `bytes === 0`. Both comparisons are only
  // sound because a non-null result is a real, non-negative number — never
  // NaN, which compares false against every relational operator and would
  // pass straight through as a budget.
  it('returns null or a finite non-negative number, never NaN', () => {
    for (const raw of [
      '8GB',
      '0',
      '1B',
      'lots',
      '',
      '-1',
      '1.5GB',
      'NaN',
      '0x10',
      '9007199254740993',
      ' ',
    ]) {
      const n = parseSize(raw)
      expect({ raw, ok: n === null || (Number.isFinite(n) && n >= 0) }).toEqual({ raw, ok: true })
      expect(Number.isNaN(n as number)).toBe(false)
    }
  })

  // project-loader.ts:627 admits a string memory declaration when
  // `PERCENT_RE.test(memory) || parseSize(memory) !== null`, and resources.ts:36
  // then resolves it with `parseSize(v) ?? 0`. The two must agree: anything the
  // loader lets through the parseSize arm must resolve to a real number, or a
  // declared reservation silently becomes zero — "reserve nothing" — and the
  // scheduler over-admits without a diagnostic.
  it('resolves every non-percent string the loader admits (no silent zero)', () => {
    const declared: ReadonlyArray<readonly [string, number]> = [
      ['512MB', 512 * MiB],
      ['2GB', 2 * GiB],
      ['8G', 8 * GiB],
      ['1048576', MiB],
      ['1B', 1],
      ['4096b', 4096],
      // The one legal string that DOES resolve to zero — because the user
      // declared zero, not because the `?? 0` fallback fired.
      ['0', 0],
    ]
    for (const [raw, want] of declared) {
      expect({ raw, got: parseSize(raw) }).toEqual({ raw, got: want })
    }
  })

  it('refuses the strings the loader must reject with a UserError', () => {
    for (const raw of ['1.5GB', '-1', 'big', '', '1 GB', '1KiB']) rejects(raw)
  })

  // parseSize's own `(\d+)` capture is handed straight to parseDecimalInt
  // (size.ts:14). Tightening parseDecimalInt (e.g. a "no leading zeros" rule)
  // would silently turn `--max-size 007M` into a flag error, so this pins the
  // coupling from this side too.
  it('accepts every capture shape its own regex can produce', () => {
    for (const capture of ['0', '00', '007', '1', '512', '0'.repeat(20) + '5']) {
      expect(parseSize(capture)).toBe(Number(capture))
      expect(parseSize(capture + 'K')).toBe(Number(capture) * KiB)
    }
  })

  // The barrel is the only legal cross-module import target for `util`, so
  // dropping the re-export would break all four callers while every direct
  // import in this file kept passing.
  it('is the same function through the util contract', () => {
    expect(parseSizeViaBarrel).toBe(parseSize)
    expect(parseSizeViaBarrel('512MB')).toBe(512 * MiB)
    expect(parseSizeViaBarrel('1.5GB')).toBeNull()
  })
})
