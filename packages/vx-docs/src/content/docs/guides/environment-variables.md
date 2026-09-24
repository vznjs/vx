---
title: Environment variables
description: A task sees only the variables you pass it. Two lists decide it — exec.env.passThrough (the command sees it) and cache.inputs.env (the key sees it).
---

Give a task the variables it needs, and key the cache on the ones that
change its output. Why? → [Chapter 6: Can you trust a hit?](../../guide/trust/)

## Steps

1. The command must see a variable? Add it to `exec.env.passThrough`.
2. It changes what the task produces? Add it to `cache.inputs.env` too.
3. A secret or a CI flag (`CI`, `GH_TOKEN`)? `passThrough` only: it must not split the cache.
4. A fixed value? Set it in `exec.env.define`. It is in the key because it is in the config.

## Config

```ts
// packages/app/vx.config.ts
import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    build: {
      exec: {
        command: 'vite build',
        env: {
          passThrough: ['NODE_ENV', 'SENTRY_AUTH_TOKEN'], // the command sees these
          define: { PUBLIC_API: 'https://api.example.com' }, // a literal, in the key
        },
      },
      cache: {
        inputs: { files: ['src/**'], env: ['NODE_ENV'] }, // the key sees NODE_ENV
        outputs: { files: ['dist/**'] },
      },
    },
  },
})
```

## The two lists

| List                   | The command sees it | The key sees it |
| ---------------------- | ------------------- | --------------- |
| `exec.env.passThrough` | yes                 | no              |
| `cache.inputs.env`     | no                  | yes             |
| `exec.env.define`      | yes                 | yes             |

The child always gets a small essential allowlist so normal CLI tools
work: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`,
`TMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`, `FORCE_COLOR`,
`NO_COLOR`, `CI`, `NODE_OPTIONS`, plus the Windows essentials. The
package's `node_modules/.bin` is first on `PATH`.

## Common problems

- **The command cannot see a variable.** It is in `cache.inputs.env` only. Add it to `exec.env.passThrough`.
- **A stale hit after changing a variable.** It is in `passThrough` only. Add it to `cache.inputs.env`.
- **A remote task cannot see a variable.** `passThrough` stays on this machine: use `define` or `inputs.env`, or keep the task local with `exec.remote: false`.

What vx itself reads (`VX_TIMING`, …): [the CLI reference](../../cli/#environment-variables-vx-reads).
