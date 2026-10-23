---
title: 'A task sees only the env it names'
date: 2026-10-09T06:40:00Z
authors:
  - vzn
tags:
  - caching
  - security
excerpt: 'Your shell holds dozens of variables, and some of them are credentials. A vx task gets a short fixed list plus the names you write down, and any value that looks like a secret prints as ***.'
---

```sh frame="terminal"
$ env | wc -l
189
$ vx run packages/d#envcount        # command: env | wc -l
9
```

Your shell holds tokens, cloud keys, proxies and leftovers. A task gets
a short fixed list plus the names you write down. Linux x64, vx at
`69617eb`, 2026-10-23.

```ts
// packages/d/vx.config.ts
import { defineProject } from '@vzn/vx/config'

export default defineProject({
  tasks: {
    env: {
      exec: {
        command:
          'echo "FOO=$FOO" && echo "NODE_ENV=$NODE_ENV" && echo "DEPLOY_TOKEN=$DEPLOY_TOKEN" && echo "GH_PAT=$GH_PAT"',
        env: {
          passThrough: ['DEPLOY_TOKEN', 'GH_PAT'],
          define: { NODE_ENV: 'production' },
          secret: ['GH_PAT'],
        },
      },
    },
  },
})
```

```sh frame="terminal"
$ FOO=leaked DEPLOY_TOKEN=s3cr3t-value-123 GH_PAT=ghp_abcdef123456 vx run packages/d#env
┌─ packages/d#env > $ echo "FOO=$FOO" && echo "NODE_ENV=$NODE_ENV" && echo "DEPLOY_TOKEN=$DEPLOY_TOKEN" && echo "GH_PAT=$GH_PAT"
FOO=
NODE_ENV=production
DEPLOY_TOKEN=***
GH_PAT=***
└─ packages/d#env ── (4ms) success
```

`FOO` never reached the task. `NODE_ENV` came from the config. Both
tokens arrived, and both printed as `***`.

## Three layers

| Layer          | Example                         | In the cache key? |
| -------------- | ------------------------------- | ----------------- |
| always passed  | `PATH`, `HOME`, `TMPDIR`, locale, `CI`, `NODE_OPTIONS` | no |
| `passThrough`  | a token from your environment   | no                |
| `define`       | a literal value in the config   | yes               |

`passThrough` stays out of the key, so a laptop and a CI runner still
share a hit. `secret` marks a name to mask that vx wouldn't guess.

## Masked everywhere vx prints

A name holding `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `PASSWD` or
`CREDENTIAL` is masked unasked. `GH_PAT` holds none, so it is listed in
`secret`. Masking covers the live log, the output a hit replays, the
command a remote cache receives, `vx show`, `vx why`, `vx last`,
telemetry and agent JSON. A multi-line key is masked line by line, and
a value split across two output chunks is still caught.

## When a variable changes the output

Some variables change what a build produces, like `NODE_OPTIONS`
loading a loader. vx doesn't guess which. Name it, and the value joins
the key:

```ts
inputs: { files: ['src/**'], env: ['NODE_OPTIONS'] }, cache: { outputs: { files: ['dist/**'] } }
```

## Hygiene, not a wall

Dropping variables keeps builds the same across machines. It doesn't
stop a task that goes looking: an unsandboxed task runs as you.

- **Linux:** vx makes itself non-dumpable, so a task can't read vx's
  environment (`VX_DEBUG_DUMPABLE=1` turns that off for strace and
  debuggers).
- **macOS:** vx zeroes the values `ps eww` reads, all but the
  essentials every task gets.

That guards the environment, not your files. To keep a task away from
what it wasn't given, use `exec.sandbox`.

Rules: [schema](../../schema/). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
