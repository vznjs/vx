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
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhy[0m[4m[58;2;110;118;129m [2m@demo/ui#build[0m[4m[58;2;110;118;129m                                                                                                    [0m
  [2mrun     [0m  [38;2;203;213;225m01a1b340-c53d-732a-82a6-2ead366e3c78[0m
  [2mthis run[0m  [38;2;203;213;225m2026-11-06T23:45:28.917Z · success · executed · key f3d649f6face354a[0m
  [2mprevious[0m  [38;2;203;213;225m2026-11-06T23:45:28.739Z · success · executed · key c0ee5e419d3c00e6[0m
  [2mverdict [0m  [38;2;234;179;8mcache key changed: file packages/ui/src/index.ts[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhat changed[0m[4m[58;2;110;118;129m [2m1 of 3[0m[4m[58;2;110;118;129m                                                                                                   [0m
  [2mchange   kind  name                      before → after[0m
  [38;2;234;179;8mchanged[0m  [38;2;203;213;225mfile[0m  [1mpackages/ui/src/index.ts[0m  [38;2;203;213;225md00491fd7e5bb6fa28c517a0bb32b8b506539d4d → 0cfbf08886fca9a91cb753ec8734c84fcbe52c9f[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhat to do[0m[4m[58;2;110;118;129m                                                                                                            [0m
  [2mfile    [0m  [38;2;203;213;225man edit re-runs by design; a file the task does not read belongs out of inputs.files[0m
```

---

When the change came from a dependency, Root cause follows it to the file
that moved:

```sh
vx why @demo/web#build
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhy[0m[4m[58;2;110;118;129m [2m@demo/web#build[0m[4m[58;2;110;118;129m                                                                                                   [0m
  [2mrun     [0m  [38;2;203;213;225m01a1b340-c53d-732a-82a6-2ead366e3c78[0m
  [2mthis run[0m  [38;2;203;213;225m2026-11-06T23:45:28.947Z · success · executed · key 6d8a0d5a1c50e288[0m
  [2mprevious[0m  [38;2;203;213;225m2026-11-06T23:45:28.766Z · success · executed · key 9f5b31f786697a14[0m
  [2mverdict [0m  [38;2;234;179;8mcache key changed: upstream @demo/ui#build[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhat changed[0m[4m[58;2;110;118;129m [2m1 of 4[0m[4m[58;2;110;118;129m                                                                                                   [0m
  [2mchange   kind      name            before → after[0m
  [38;2;234;179;8mchanged[0m  [38;2;203;213;225mupstream[0m  [1m@demo/ui#build[0m  [38;2;203;213;225mc0ee5e419d3c00e6 → f3d649f6face354a[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mRoot cause[0m[4m[58;2;110;118;129m                                                                                                            [0m
  [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m ← [0m[38;2;192;132;252m@demo/ui[0m[2m#[0m[38;2;244;114;182mbuild[0m[2m ← [0m[1mfile packages/ui/src/index.ts[0m

[4m[58;2;110;118;129m  [1m[38;2;167;139;250mWhat to do[0m[4m[58;2;110;118;129m                                                                                                            [0m
  [2mfile    [0m  [38;2;203;213;225man edit re-runs by design; a file the task does not read belongs out of inputs.files[0m
```

---

An agent or a script can read the same answer as JSON:

```sh
vx why @demo/ui#build --format json
```

See [`vx why`](../../../cli/why/).
