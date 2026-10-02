# `src/util/real-path.ts` — a path's canonical spelling

## Purpose

One canonical spelling per path, so a key that folds a path and a
caller that compares it agree (O-16: the config-eval closure once
folded one spelling while every caller compared another).

## Public surface

```ts
export function realPath(p: string): string
```

- `realpathSync.native`: the OS's final path for `p`. Throws as
  `realpathSync` does.

## Tests

`tests/real-path.test.ts` holds `realPath(os.tmpdir())` equal to
`fs.promises.realpath` of it.
