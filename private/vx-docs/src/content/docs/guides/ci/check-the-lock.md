---
title: Fail CI when the lock is stale
description: Use vx lock --check to fail a build whose configs changed without vx lock.
---

Runs read every project's config from `.vx/projects.lock.json`, which
`vx lock` writes. Add `vx lock --check` to CI to fail a change that edited a
`vx.config.ts` without running `vx lock`.

```sh
vx lock --check
```

```ansi
[38;2;239;68;68m✗[0m [1mvx lock --check[0m  packages/ui/vx.config.ts evaluates differently from the lock here — its config, a file it imports, or the environment it reads changed; run 'vx lock'
```

It exits `1` and names each project that drifted. With a current lock it
exits `0`:

```ansi
[38;2;34;197;94m✓[0m [1mvx lock --check[0m  up to date (2 projects)
```

---

In GitHub Actions, run it before the build:

```yaml title=".github/workflows/ci.yml"
- run: vx lock --check
- run: vx run build --all
```

See [`vx lock`](../../../cli/lock/).
