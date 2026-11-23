---
title: Pass an environment variable to a task
description: List a variable in exec.env.passThrough so the task's command can read it.
---

A task sees only the environment variables you list. To pass one, add
its name to `exec.env.passThrough`.

```ts title="packages/web/vx.config.ts" mark={8}
import type { ProjectConfig } from '@vzn/vx/config'

export default {
  tasks: {
    deploy: {
      exec: {
        command: 'echo "deploying to $DEPLOY_ENV"',
        env: { passThrough: ['DEPLOY_ENV'] },
      },
    },
  },
} satisfies ProjectConfig
```

Without that line, the command sees no `DEPLOY_ENV`, even when your
shell sets it:

```sh
DEPLOY_ENV=staging vx run @demo/web#deploy
```

```ansi
[2m┌─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;244;114;182mdeploy[0m [2m>[0m $ echo "deploying to $DEPLOY_ENV"
deploying to
[2m└─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;244;114;182mdeploy[0m [2m──[0m [2m(12ms)[0m [2msuccess[0m
```

With it, run `vx lock`, then the same command:

```sh
DEPLOY_ENV=staging vx run @demo/web#deploy
```

```ansi
[2m┌─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;244;114;182mdeploy[0m [2m>[0m $ echo "deploying to $DEPLOY_ENV"
deploying to staging
[2m└─[0m [1m[38;2;244;114;182m@demo/web[0m[2m#[0m[1m[38;2;244;114;182mdeploy[0m [2m──[0m [2m(13ms)[0m [2msuccess[0m
```

---

## When the variable changes the output

A cached task replays its saved output. If a variable changes what the
task writes, list it in `inputs.env` too, so a new value runs it again:

```ts mark={4,6}
build: {
  exec: {
    command: 'vite build',
    env: { passThrough: ['NODE_ENV'] },
  },
  inputs: { files: ['src/**'], env: ['NODE_ENV'] },
  outputs: { files: ['dist/**'] },
  cache: true,
},
```

Keep secrets such as `GH_TOKEN` in `passThrough` only. vx prints their
values as `***`.

---

`PATH`, `HOME`, `CI` and a few other basics reach every task without a
list.

See [Environment variables](../../../docs/environment-variables/).
