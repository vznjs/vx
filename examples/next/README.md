# vx with Next.js

A Next.js app and a package it imports from source: `apps/site` runs
`next build` and `oxlint`; `packages/format` runs `vitest run` and
`oxlint`. Copy it, then:

```sh
bun install
vx lock                  # record the configs and what bun.lock resolves
git init && git add -A && git commit -m init   # vx reads the tree from git
vx run build test lint --all   # 4 tasks run: local 4↑
vx run build test lint --all   # nothing changed: local 4✓
```

`format` has no build: Next compiles it (`transpilePackages`). vx gives
it a default `build` keyed on all its files, so editing
`packages/format/src/index.js` rebuilds `site`.

`site#build` caches `.next/` without `.next/cache`, so a hit restores a
build `next start` can serve.

After editing a `vx.config.ts` or installing, run `vx lock` and commit the
locks. More: [Quickstart](https://vznjs.github.io/vx/quickstart/).

`packages/vx/tests/examples.live.test.ts` installs and runs this starter
on CI whenever it or vx changes.
