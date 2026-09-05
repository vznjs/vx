---
title: Environment variables
description: vx isolates the child environment by design. Learn the two lists that matter — passThrough (forward a value) and inputs.env (track it in the cache) — and when to use each.
---

vx runs each task with a **deliberately limited environment**. Host env
vars don't leak into your tasks unless you say so. This prevents two
classes of bug: cache misses from irrelevant differences (every shell
with a different `PS1` would otherwise miss), and non-reproducible builds
from values silently leaking between machines.

That means there are two questions to answer for any env var a task
cares about, and they're independent:

1. **Does the command need to *see* it?** → `exec.env.passThrough`
2. **Should a change to it *invalidate the cache*?** → `cache.inputs.env`

## The two lists

```ts
build: {
  exec: {
    command: 'vite build',
    env: {
      passThrough: ['NODE_ENV', 'SENTRY_AUTH_TOKEN'], // forwarded to the child
      define: { PUBLIC_API: 'https://api.example.com' }, // literal, set explicitly
    },
  },
  cache: {
    inputs: {
      files: ['src/**'],
      env: ['NODE_ENV'],          // a change to NODE_ENV busts the cache
    },
    outputs: { files: ['dist/**'] },
  },
}
```

- **`exec.env.passThrough`** — names whose **value is taken from the host
  `process.env`** and given to the child. Values are **not** folded into
  the cache key. Perfect for secrets, tokens, and CI flags that
  legitimately vary between machines.
- **`exec.env.define`** — explicit `name: value` literals. Because they
  live in your config, they **are** in the cache key naturally.
- **`cache.inputs.env`** — names whose **host value is folded into the
  cache key**. Listing a name here does *not* forward it to the child.

## The rule of thumb

> If an env var changes what the build produces, list it in **both**
> `cache.inputs.env` (so the cache notices) **and** `exec.env.passThrough`
> (so the command can see it).

Listing it only in `inputs.env` keys the cache on a value the command
never receives — incoherent. Listing it only in `passThrough` lets the
value reach the build but won't invalidate the cache when it changes —
the stale-hit trap.

```ts
exec: { command: 'vite build', env: { passThrough: ['DEPLOY_TARGET'] } },
cache: { inputs: { files: ['src/**'], env: ['DEPLOY_TARGET'] }, outputs: { files: ['dist/**'] } },
```

## Secrets and CI flags: passThrough only

A token doesn't change *what* you build, so forward it without keying the
cache on it:

```ts
test: {
  exec: { command: 'bun test', env: { passThrough: ['CI', 'GH_TOKEN'] } },
  cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
}
```

`CI=1` is true on every CI run; keying the cache on it would mean local
and CI never share entries. Pass it through, don't track it.

## What's always available

The child always gets a small essential allowlist so normal CLI tools
work: `PATH`, `HOME`, `SHELL`, `TMPDIR`, `LANG`, `TERM`, `COLORTERM`,
`FORCE_COLOR`, `NO_COLOR`, `CI`, `NODE_OPTIONS`, plus the Windows
essentials. Each package's own `node_modules/.bin` is prepended to
`PATH`. Everything else is invisible unless passed through.

## Remote execution: only two of the three lists travel

If a task runs on a remote worker (see
[Remote execution](../remote-execution/)), the action that gets sent carries
`exec.env.define` and `cache.inputs.env` — and nothing else.

`exec.env.passThrough` **does not cross**, and neither does the essential
allowlist. Those are *this* machine's resolved values, and they are excluded
for the same reason they are excluded from the cache key: bake a laptop's
`HOME` into the action and that laptop can never share a result with a CI
runner. There is a second reason for `passThrough` specifically — it is where
secrets go, and an action's command is stored in the shared content-addressed
store, where anyone who can name its digest can read it.

So for a task you want to run remotely:

- a value that is the same everywhere → `exec.env.define`
- a value that varies by machine and changes the output → `cache.inputs.env`
  (it is keyed, so a change already produces a different action)
- a secret the command must read → keep the task local with
  `exec: { remote: false }`

## Coming from Turborepo

This maps cleanly:

| Turborepo            | vx                          |
| -------------------- | --------------------------- |
| `env`                | `cache.inputs.env` **+** `exec.env.passThrough` |
| `passThroughEnv`     | `exec.env.passThrough`      |
| `globalEnv`          | a shared TS array you spread into each task's `inputs.env` |

`vx migrate` translates these for you — see
[Migrate from Turborepo](../../migrate/from-turborepo/).

## Next steps

- **[Caching tasks](../caching/)** — env vars as part of the cache key.
- **[Configuration reference](../../schema/#execenv-optional)** — the
  exact `ExecEnv` and `inputs.env` semantics.
