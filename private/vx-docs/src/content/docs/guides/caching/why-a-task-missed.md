---
title: Find why a task missed the cache
description: Use vx why to name the input that changed since a task's last run.
---

Use `vx why` to see why a task ran instead of coming from the cache. It
compares the task's last two runs and names the part of the key that changed.

```sh
vx why @demo/ui#build
```

```text
@demo/ui#build — run 01a16ac2-358b-71ea-9f9a-3893813f3fe5
  this run   2026-10-23T21:54:35.035Z · success · executed · key ea371b1a95a3f4d4
  previous   2026-10-23T21:54:34.326Z · success · key 58326ea9fe2ca71f
  verdict    cache key changed: file packages/ui/src/index.ts

  what changed (1 component, 2 unchanged):
    changed file  packages/ui/src/index.ts  d00491fd7e5bb6fa28c517a0bb32b8b506539d4d → 0cfbf08886fca9a91cb753ec8734c84fcbe52c9f

  what to do:
    file  an edit re-runs by design; a file the task does not read belongs out of inputs.files
```

---

When the change came from a dependency, `root cause` follows it to the file
that moved:

```sh
vx why @demo/web#build
```

```text
@demo/web#build — run 01a16ac2-358b-71ea-9f9a-3893813f3fe5
  this run   2026-10-23T21:54:35.065Z · success · executed · key 3bc7cf8209349dfd
  previous   2026-10-23T21:54:34.351Z · success · key 90ae2fa5dbcfde91
  verdict    cache key changed: upstream @demo/ui#build

  what changed (1 component, 3 unchanged):
    changed upstream  @demo/ui#build  58326ea9fe2ca71f → ea371b1a95a3f4d4

  root cause:
    @demo/web#build ← @demo/ui#build ← file packages/ui/src/index.ts

  what to do:
    file      an edit re-runs by design; a file the task does not read belongs out of inputs.files
```

---

An agent or a script can read the same answer as JSON:

```sh
vx why @demo/ui#build --format json
```

See [`vx why`](../../../cli/#vx-why).
