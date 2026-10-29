---
title: Find why a task missed the cache
description: Use vx why to name the input that changed since a task's last run.
---

Use `vx why` to see why a task ran instead of coming from the cache. It
compares the task's last two runs and names the part of the key that changed.
Here `verdict` names the edited file:

```sh
vx why @demo/ui#build
```

```ansi
[38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m — run 01a1837e-0b4b-7241-af39-b92b265ca8ba[0m
  [2mthis run[0m   2026-10-28T17:10:38.177Z · success · executed · key 45685ae013662a8f
  [2mprevious[0m   2026-10-28T17:10:37.430Z · success · executed · key 2132002e64f489a6
  [2mverdict[0m    [38;2;234;179;8mcache key changed: file packages/ui/src/index.ts[0m

  [1mwhat changed[0m[2m (1 component, 2 unchanged)[0m:
    [38;2;234;179;8mchanged[0m [2mfile[0m  packages/ui/src/index.ts  [2md00491fd7e5bb6fa28c517a0bb32b8b506539d4d → 0cfbf08886fca9a91cb753ec8734c84fcbe52c9f[0m

  [1mwhat to do[0m:
    [2mfile[0m  an edit re-runs by design; a file the task does not read belongs out of inputs.files
```

---

When the change came from a dependency, `root cause` follows it to the file
that moved:

```sh
vx why @demo/web#build
```

```ansi
[38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m — run 01a1837e-0b4b-7241-af39-b92b265ca8ba[0m
  [2mthis run[0m   2026-10-28T17:10:38.215Z · success · executed · key 47fb6826eec9be22
  [2mprevious[0m   2026-10-28T17:10:37.461Z · success · executed · key 30214f14f1217b9e
  [2mverdict[0m    [38;2;234;179;8mcache key changed: upstream @demo/ui#build[0m

  [1mwhat changed[0m[2m (1 component, 3 unchanged)[0m:
    [38;2;234;179;8mchanged[0m [2mupstream[0m  @demo/ui#build  [2m2132002e64f489a6 → 45685ae013662a8f[0m

  [1mroot cause[0m:
    @demo/web#build ← @demo/ui#build ← file packages/ui/src/index.ts

  [1mwhat to do[0m:
    [2mfile    [0m  an edit re-runs by design; a file the task does not read belongs out of inputs.files
```

---

An agent or a script can read the same answer as JSON:

```sh
vx why @demo/ui#build --format json
```

See [`vx why`](../../../cli/why/).
