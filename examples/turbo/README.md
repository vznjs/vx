# Migrating a Turborepo repo to vx

A Turbo repo (`turbo.json`, package scripts) mid-migration: one file,
`vx.workspace.ts`, declares `turbo()` from `@vzn/vx-migrate`, a
temporary start until the repo has native config:

```sh
npm install
git init && git add -A && git commit -m init
npx vx run test --all    # lib#build, app#build, app#test: 3 miss
npx vx run test --all    # 3 up-to-date
```

The goal is configs of your own: `bunx @vzn/vx-migrate` writes a
`vx.config.ts` per package from the same `turbo.json`. They derive the
same cache keys, so the cache `turbo()` filled still hits.

`packages/vx/tests/examples.unsafe.test.ts` runs both paths on every CI
run.
