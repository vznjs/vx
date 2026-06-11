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

## Replacing this module

If versioning ever derives from `package.json` at build/publish time,
this file is the single place to generate.
