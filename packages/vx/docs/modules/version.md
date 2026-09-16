# `src/version.ts` — the VERSION constant

## Purpose

A one-export leaf holding the package version string. Extracted from
`index.ts` so that `cli` and `orchestrator` (which print the version
in banners/`--version`) don't import the public façade — that import
formed a cycle (`index → orchestrator → index`) that only worked via
ESM live-binding hoisting.

## Public surface

```ts
export const VERSION: string
```

`index.ts` re-exports it, so the public package name is unchanged.

The single source of truth is `package.json`: the file imports it
(`pkg.version`), Bun resolves the JSON import natively and inlines it
under `bun build --compile`, so a release bump can never drift from
what `--version` and the footer print.

## Replacing this module

A version from anywhere else (a build stamp, a git describe) is this
one import to change; every reader takes `VERSION`.
