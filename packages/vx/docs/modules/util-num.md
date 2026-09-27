# `src/util/num.ts` — integers at the boundaries

## Purpose

The numeric rules every argument boundary shares, and the one duration format every surface prints, in one place.

```ts
export const MAX_TIMEOUT_MS = 2 ** 31 - 1
clampInt(n, min, max): number
parseDecimalInt(input): number | null
formatElapsed(ms, minutes?): string
```

- **`MAX_TIMEOUT_MS`** is the largest delay `setTimeout` honours
  (~24.8 days). A larger one does not saturate and does not throw — it
  silently becomes **1 ms**, the inverse of what was asked: a task
  declaring a 317-year timeout would be SIGTERMed 4 ms after it spawns.
  Every surface that accepts a millisecond delay bounds against it.
- **`clampInt`** floors to an integer in `[min, max]`; non-finite
  collapses to `min`. The floor is load-bearing wherever the result
  reaches SQL: a fractional `LIMIT` is a `datatype mismatch`, not a
  smaller page.
- **`parseDecimalInt`** accepts a plain decimal integer only. `Number()`
  at an argument boundary accepts hex, exponents, fractions, a leading
  `+` and whitespace, so a typo becomes a different number instead of
  an error; values past `MAX_SAFE_INTEGER` parse to a number the user
  did not type and are rejected too.
- **`formatElapsed`** is a duration as vx prints it: `12ms`, `1.23s`,
  and with `minutes` (`vx last`) `2m 5s`. The value is rounded to the
  unit shown before the unit is chosen: 999.6 ms printed `1000ms` and
  119,600 ms `1m 60s` (item 1034).

`parseDecimalInt` and `clampInt` are re-exported from `@vzn/vx` for
plugins that parse their own arguments.

## Tests

`tests/util-num.test.ts`; `tests/timeout-bounds.test.ts` (every
timeout surface against the ceiling); `tests/options-resolve.test.ts`.
