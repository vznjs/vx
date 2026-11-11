# `src/util/real-path.ts` — a path's canonical spelling

## Purpose

One canonical spelling per path, so a key that folds a path and a
caller that compares it agree (O-16: the config-eval closure once
folded one spelling while every caller compared another).

## Public surface

```ts
export function realPath(p: string): string
export function realpathOf(p: string): string
export function sameDir(a: string, b: string): boolean
```

- `realPath` — `realpathSync.native`: the OS's final path for `p`.
  Throws as `realpathSync` does.
- `realpathOf` — `realpathSync`, for a path holding a backslash too.
  Bun's realpath answers ENOENT for any such path (1.4.2); this one
  reads its links one by one instead. Used by output containment
  (`cache/inputs.ts`).
- `sameDir` — whether `a` and `b` stat to one directory (same device
  and inode): two spellings a disk folds together, such as APFS's NFC
  and NFD `café`. Linux keeps those as two directories, so git's
  enumeration (`cache/git-inputs.ts`) and `--affected`
  (`workspace/affected.ts`) match a project dir by its own spelling
  first and by its NFC name only when this holds.

## Tests

`tests/real-path.test.ts` holds `realPath(os.tmpdir())` equal to
`fs.promises.realpath` of it, and `realpathOf` through a chain of
backslash-named links agreeing with what the kernel opens.
`tests/inputs-resolution.test.ts` (an output under `dist/a\b/` is kept)
holds it through its caller. `tests/git-enum-unicode.test.ts` and
`tests/affected-unicode.test.ts` hold `sameDir` through its callers:
NFC and NFD sibling projects each keep their own files on Linux, and an
NFD spelling of the NFC dir (a link, as APFS folds the names) still
takes git's NFC paths.
