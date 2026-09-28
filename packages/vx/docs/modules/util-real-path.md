# `src/util/real-path.ts` — a path's canonical spelling

## Purpose

On Windows `realpathSync` keeps an 8.3 short name
(`C:\Users\RUNNER~1\AppData\…`) where git, `fs.promises.realpath` and
the OS's final path say `runneradmin`. The config-eval closure folded
the short spelling into its key while every caller compared the long
one (O-16, the Windows job: every `configEvalKey` closure row).

## Public surface

```ts
export function realPath(p: string): string
```

- `realpathSync.native`: the OS's final path for `p`. Throws as
  `realpathSync` does.
- On Linux and macOS it answers what `realpathSync` does.

## Tests

`tests/real-path.test.ts` holds `realPath(os.tmpdir())` equal to
`fs.promises.realpath` of it; the Windows job, whose temp dir is a short
name, is the platform that can fail it.
