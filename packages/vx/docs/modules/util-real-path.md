# `src/util/real-path.ts` — a path's canonical spelling

## Purpose

One canonical spelling per path, so a key that folds a path and a
caller that compares it agree (O-16: the config-eval closure once
folded one spelling while every caller compared another).

## Public surface

```ts
export function realPath(p: string): string
export function realpathOf(p: string): string
```

- `realPath` — `realpathSync.native`: the OS's final path for `p`.
  Throws as `realpathSync` does.
- `realpathOf` — `realpathSync`, for a path holding a backslash too.
  Bun's realpath answers ENOENT for any such path (1.4.2); this one
  reads its links one by one instead. Used by output containment
  (`cache/inputs.ts`) and the member grouping (`workspace/workspace.ts`).

## Tests

`tests/real-path.test.ts` holds `realPath(os.tmpdir())` equal to
`fs.promises.realpath` of it, and `realpathOf` through a chain of
backslash-named links agreeing with what the kernel opens.
`tests/inputs-resolution.test.ts` (an output under `dist/a\b/` is kept)
and `tests/workspace-member-alias.test.ts` (a member and a backslash
link to it are one project) hold it through its callers.
