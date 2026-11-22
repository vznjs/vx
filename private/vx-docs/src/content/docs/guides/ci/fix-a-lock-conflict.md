---
title: Fix a merge conflict in the lock
description: Resolve the vx.config.ts files, run vx lock, and commit the lock it writes.
---

vx keeps every project's config in `.vx/projects.lock`. When two branches
change configs, git can leave a conflict in it. Every run then refuses
the lock:

```sh
vx run build --all
```

```ansi
[38;2;239;68;68m✗[0m [1mvx run[0m  .vx/projects.lock holds a line `vx lock` never writes — re-run `vx lock`
```

Never edit the lock by hand. Fix it in three steps:

1. Resolve the conflicts in your `vx.config.ts` files, as for any code.
2. Run `vx lock`. It writes the lock again from the merged configs:

   ```sh
   vx lock
   ```

   ```ansi
   [38;2;34;197;94m✓[0m [1mvx lock[0m  2 project configs → .vx/projects.lock, .vx/dependencies.lock
   ```

3. Commit the result:

   ```sh
   git add -A
   git commit
   ```

`vx lock` also rewrites `.vx/dependencies.lock` and each `vx.lock.json`,
so their conflicts go away too.

See [The lock](../../../docs/workspace/).
