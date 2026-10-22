# Migrating a Turborepo repo to vx

A Turbo repo (`turbo.json`, package scripts) mid-migration: one file,
`.vx/workspace.ts`, declares `turbo()` from `@vzn/vx-migrate`, a
temporary start until the repo has native config:

```sh
bun install
git init && git add -A && git commit -m init
vx run test --all    # lib#build, app#build, app#test: local 3↑
vx run test --all    # local 3✓
```

The goal is configs of your own: `bunx @vzn/vx-migrate` writes a
`vx.config.ts` per package from the same `turbo.json`. They derive the
same cache keys, so the cache `turbo()` filled still hits. A run reads
configs only from `.vx/projects.lock.json`, which `vx lock` writes (`vx-migrate`
runs it); after editing a config, run `vx lock` again.

`packages/vx/tests/examples.unsafe.test.ts` runs both paths on every CI
run.
