# `src/util/edit-distance.ts` — the one "did you mean" rule

## Purpose

Every near-miss hint core prints — task names, `pkg#task` halves,
project names, flags, verbs, config keys — goes through one
rule, so a typo is hinted the same way wherever it is typed.

## Public surface

```ts
editDistance(a, b, cap = 3): number   // Levenshtein, capped: `cap` or more edits read as `cap`
nearest(name, candidates, maxEdits = 2): string | undefined
nearMatches(name, candidates, limit = 3): string[]
```

- `nearest` is THE hint: the closest candidate within `maxEdits`, or
  nothing — an exact match is not a hint, and anything further would
  guess rather than help. `flagHint` (`cli/help.ts`) widens to three edits only among
  flags sharing a five-character stem (`--retries` → `--retry`), so
  `--zzz` never reaches `--all`.
- `nearMatches` is for the inspection verbs (`why`, `show`) that list
  a few candidates instead of picking one: nearest by distance first,
  then case-insensitive containment either way, never `name` itself.

## Tests

`tests/near-miss.test.ts` (every surface that hints, the exact-match
and beyond-two-edits controls); `tests/no-cache-word.test.ts`.
