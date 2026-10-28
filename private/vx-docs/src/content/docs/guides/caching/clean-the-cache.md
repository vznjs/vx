---
title: Clear the local cache
description: Use vx cache clean to empty the cache, or to keep it under an age or a size.
---

Use `vx cache clean` with no flag to empty this repository's local cache.

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

Add `--dry` to see what would go without deleting anything. No run
evicts entries on its own, so run a bound from a schedule or CI.

See [`vx cache clean`](../../../cli/cache/).
