# `src/util/git-attributes.ts` — which paths a clean filter can rewrite

## Purpose

An index OID is the filtered blob, not the bytes a task reads, so a path
an attribute converts is hashed from disk (cache/git-inputs.ts
`dropFilteredOids`) and is a change to `--affected` (workspace/affected.ts).
Both ask git the same question here.

## Public surface

```ts
export const CHECK_ATTR: string[]
export function parseCheckAttrOutput(out: string): Set<string>
```

- `CHECK_ATTR`: `git check-attr --stdin -z --all`, the paths on stdin.
  `--all` prints only what a rule sets; asked by name, git printed all
  five converting attributes for every path, `unspecified` included
  (vueuse: 473 KB and ~5 ms of the main thread a run, 160 KB under
  `--all`).
- `parseCheckAttrOutput`: the paths with `text`, `eol`, `ident`,
  `filter`, `working-tree-encoding` or the legacy `crlf` set to anything
  but `unset` (or `unspecified`). What converts nothing (`diff`,
  `linguist-generated`, the `binary` macro's own line) is ignored.
