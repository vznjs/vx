---
title: Set a time limit on a task
description: Use exec.timeout or --timeout so a stuck task fails instead of hanging the run.
---

A task has no time limit unless you set one. To stop a stuck test suite
from hanging the run, give it `exec.timeout`:

```ts title="packages/web/vx.config.ts" mark={4}
export default {
  tasks: {
    'test.playwright': {
      exec: { command: 'playwright test', timeout: '10m' },
    },
  },
}
```

A duration needs its unit: `'500ms'`, `'30s'`, `'10m'`, `'1h'`.

---

To limit every task in one run, pass `--timeout`. Here the suite takes
longer than one second:

```sh
vx run @demo/web#test.playwright --timeout 1s
```

```ansi
[2m┌─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;96;165;250mtest.playwright[0m [2m>[0m $ sleep 5
[vx] timed out after 1000ms — killed (SIGTERM)
[2m└─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;96;165;250mtest.playwright[0m [2m──[0m [2m(1.01s)[0m [1m[38;2;239;68;68mfailed (timed out, exit 143)[0m
```

vx stops the task, marks it `failed (timed out)`, and exits `1`. A task's
own `exec.timeout` wins over the flag.

---

To set a default for the whole workspace, add `run.timeout` to
`.vx/workspace.ts`:

```ts title=".vx/workspace.ts" mark={4}
import type { WorkspaceConfig } from '@vzn/vx/config'

export default {
  run: { timeout: '30m' },
} satisfies WorkspaceConfig
```

See [Workspace settings](../../../docs/workspace/).
