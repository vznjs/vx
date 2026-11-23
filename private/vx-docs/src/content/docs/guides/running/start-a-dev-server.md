---
title: Start a dev server before your tests
description: Mark a server task persistent with readyWhen, and the tasks that depend on it start once it is ready.
---

Mark the server task `persistent` and tell vx which line means "ready".
Tasks that depend on it start once the server prints that line.

```ts title="packages/web/vx.config.ts" mark={6}
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    dev: {
      exec: { command: 'vite', persistent: { readyWhen: 'Local:' }, timeout: '30s' },
    },
    e2e: {
      dependsOn: ['dev'],
      exec: { command: 'playwright test' },
    },
  },
} satisfies ProjectConfig
```

| Key | What it means |
| --- | --- |
| `persistent` | the task keeps running, like a server or a watcher |
| `readyWhen` | the output line that means it is ready to use |
| `timeout` | how long to wait for that line before the task fails |

Run `vx lock`, then add `--dry` to see the order:

```sh
vx run e2e --dry
```

```ansi
[4m[58;2;110;118;129m  [1m[38;2;167;139;250mPlan[0m[4m[58;2;110;118;129m [2m2[0m[4m[58;2;110;118;129m    [2mstatus  cache      usual    time   cpu    mem outputs  blocks worker         task[0m[4m[58;2;110;118;129m                           [0m
            [38;2;6;182;212mrun[0m     [2mno-cache[0m       [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [2m0[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;147;197;253me2e[0m
            [38;2;6;182;212mrun[0m     [2mno-cache[0m       [2m—[0m       [2m—[0m     [2m—[0m      [2m—[0m       [2m—[0m       [38;2;203;213;225m1[0m [2mlocal[0m          [38;2;244;114;182m@demo/web[0m[2m#[0m[38;2;147;197;253mdev[0m

  [2mtasks   [0m  [38;2;203;213;225m2 planned · 2 no-cache[0m
```

`blocks 1` on `dev` means one task waits for it. Drop `--dry` and vx
starts `vite`, waits for `Local:`, runs `playwright test`, then stops
the server.

---

A persistent task is never cached. When the run ends, vx sends it
`SIGTERM`, then `SIGKILL` if it is still alive two seconds later.

See [Dev servers](../../../docs/dev-servers/).
