---
title: Run only what changed
description: Use --affected to run the tasks a git change reaches, and nothing else.
---

Use `--affected` to run a task only where your branch changed files, plus
every task that depends on one of them.

```sh
vx run build --affected
```

On a branch, vx compares with the commit where it left your base branch
(`main`). Add `--dry` to see what would run and why, without running it:

```sh
vx run build --affected --dry
```

```ansi
[1mwould run:[0m
  [38;2;234;179;8m▶[0m  [38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m   [38;2;234;179;8mcache miss — would exec [0m  [2mea61da13[0m[2m  ~14ms[0m
                      [2maffected: packages/ui/src/index.ts changed (an input)[0m
  [38;2;234;179;8m▶[0m  [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m  [38;2;234;179;8mcache miss — would exec [0m  [2m47fb6826[0m[2m  ~14ms[0m
                      [2maffected: packages/ui/src/index.ts changed (an input), via @demo/ui#build[0m

[2m2 task(s) planned, 2 would run.[0m
[2mpredicted: ~28ms wall · ~28ms total execution[0m
```

---

To compare with another commit, name it:

```sh
vx run test --affected=origin/main
vx run test --affected=HEAD~1
```

On the base branch itself, `--affected` has no default. Run `--all`
there: the cache still runs only what changed.

On a branch, CI's default one-commit checkout is enough. vx fetches the
history back to where the branch started, without file contents.

See [`--affected`](../../../cli/run/#--affectedbase).
