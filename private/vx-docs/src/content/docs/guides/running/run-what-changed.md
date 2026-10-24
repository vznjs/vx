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

```text
would run:
  ▶  @demo/ui#build   cache miss — would exec   ea371b1a  ~9ms
                      affected: packages/ui/src/index.ts changed (an input)
  ▶  @demo/web#build  cache miss — would exec   3bc7cf82  ~5ms
                      affected: packages/ui/src/index.ts changed (an input), via @demo/ui#build

2 task(s) planned, 2 would run.
predicted: ~14ms wall · ~14ms total execution
```

---

To compare with another commit, name it:

```sh
vx run test --affected=origin/main
vx run test --affected=HEAD~1
```

On the base branch itself there is no default: name the last commit that
passed, or set `VX_AFFECTED_BASE`. On CI the default one-commit checkout
is enough: vx fetches the base commit and the history down to where the
branch started, without file contents.

See [`--affected`](../../../cli/run/#--affectedbase).
