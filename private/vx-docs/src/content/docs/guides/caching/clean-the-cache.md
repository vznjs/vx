---
title: Clear the local cache
description: Use vx cache clean to empty the cache, or to keep it under an age or a size.
---

Use `vx cache clean` with no flag to empty this workspace's local cache. It
clears the run history too, so `vx last` and `vx why` start over.

```sh
vx cache clean
```

---

To keep recent entries, drop only those last used before a cutoff:

```sh
vx cache clean --older-than 7d
```

---

To cap the size, evict the least recently used entries until the cache fits:

```sh
vx cache clean --max-size 5GB
```

Add `--dry` to see what would go without deleting anything. A run never
removes entries, so run one of these on a schedule or in CI.

See [`vx cache clean`](../../../cli/cache/).
