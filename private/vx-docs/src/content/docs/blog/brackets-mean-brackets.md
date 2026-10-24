---
title: 'Brackets in a glob mean brackets'
date: 2026-10-20T18:20:00Z
authors:
  - vzn
tags:
  - dx
  - config
excerpt: 'In a vx glob, [jt] matches one character, as in Turbo, Nx and your shell. A Next.js route folder like app/[id] needs escaping.'
---

In a vx glob, `[jt]` matches one character, `j` or `t`. A Next.js route
folder like `app/[id]` needs escaping.

| Glob               | Matches                        |
| ------------------ | ------------------------------ |
| `src/*.[jt]s`      | `.js` and `.ts` files in `src` |
| `app/[id]/**`      | `app/i/**`, `app/d/**`         |
| `app/\[id\]/**`    | the `app/[id]/` folder         |

Turbo, Nx and shells read brackets the same way. A glob you copy from
`turbo.json` or an Nx project means the same thing in `vx.config.ts`.

## See it in a run

```ts
route: {
  exec: { command: 'ls src app/*' },
  inputs: { files: ['src/*.[jt]s', 'app/\\[id\\]/**'] },
  cache: { outputs: { files: [] } },
}
```

The double backslash is the escape inside a TypeScript string.

```sh frame="terminal"
$ echo "// e" >> app/i/x.ts          # not an input
$ vx run packages/c#route
  cache     local 1✓

$ echo "// e" >> 'app/[id]/page.ts'  # the escaped route
$ vx run packages/c#route
  cache     local 1↑

$ echo "// e" >> src/j.js            # matched by [jt]
$ vx run packages/c#route
  cache     local 1↑
```

<small>Linux x64 · vx 69617eb · 2026-10-23</small>

An edit to an input runs the task again (`1↑`). Any other edit is a
cache hit (`1✓`). `@vzn/vx-migrate` keeps Turbo's and Nx's brackets as
they are, and escapes brackets in any path it writes.

Glob rules: [Caching](../../caching/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
