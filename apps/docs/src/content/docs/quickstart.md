---
title: Quickstart
description: Install vx, write your first vx.config.ts, and run a cached, parallel task graph in about five minutes.
---

This guide takes you from nothing to a cached, parallel task graph. It
assumes **Bun ≥ 1.3** and a workspace under **git** (vx hashes inputs via
git's index, so a repo is required).

Already have a monorepo with Turborepo or Nx? Jump to
[Add vx to an existing repo](../add-to-existing-repo/) or the migration
guides ([Turborepo](../migrate/from-turborepo/),
[Nx](../migrate/from-nx/)).

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/vznjs/vx/main/install.sh | sh
```

This installs the self-contained `vx` binary to `~/.local/bin` — no Node,
no separate Bun runtime, nothing else to set up.

> An `@vzn/vx` **npm package** — `bun add -d @vzn/vx` plus the typed
> `defineProject` / `defineWorkspace` config helpers — is publishing soon.
> Until then, install the binary with the line above and write configs as
> plain objects (below).

Each task runs with the package's own `node_modules/.bin` prepended to
`PATH`, so `tsc`, `vite`, `eslint`, etc. resolve from a bare command — no
`npx` needed.

## 2. Describe a task

Drop a `vx.config.ts` next to any package's `package.json`. It exports a
plain config object:

```ts
// packages/app/vx.config.ts
export default {
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/**'] },
      },
    },
  },
}
```

Two things to internalize early:

- **Caching is opt-in and explicit.** When you add a `cache` block, both
  `inputs` and `outputs` are required. No hidden globs — you say exactly
  what the task reads and produces. (Omit `cache` entirely and the task
  always runs.)
- **One command per task.** `exec.command` is a single shell command.
  Chain steps with `&&`, or split them into separate tasks wired with
  `dependsOn` so each step caches independently.

Once the `@vzn/vx` package ships, wrap the object in `defineProject(…)`
for autocomplete and schema validation — it's an identity function with
zero runtime effect, so the plain object above works identically.

## 3. Run it

```bash
vx run build
```

The first run executes `tsc` and stores the result. Run it again:

```bash
vx run build          # ◌ cache hit — restored in milliseconds
```

vx restored `dist/**` and the captured logs from cache without running
`tsc`. Change a file under `src/` and re-run — vx detects the changed
input and rebuilds, then caches the new result.

## 4. Add a second task and a dependency

```ts
export default defineProject({
  tasks: {
    build: {
      exec: { command: 'tsc -b' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
    },
    test: {
      dependsOn: ['build'], // build must succeed first
      exec: { command: 'bun test' },
      cache: { inputs: { files: ['src/**', 'tests/**'] }, outputs: { files: [] } },
    },
  },
})
```

```bash
vx run test           # runs build → test, in order, then caches both
```

`outputs: { files: [] }` is correct for tasks like `test` and `lint` that
produce no files — you still cache the successful no-op so the next run
is instant.

## 5. Go wide across packages

Use the `^` prefix to depend on the *same task in your workspace
dependencies* — the universal monorepo pattern:

```ts
build: {
  dependsOn: ['^build'],          // build my deps before me
  exec: { command: 'tsc -b' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
}
```

Now run across the whole workspace:

```bash
vx run build --all              # every package, in dependency order
vx run build --filter "@app/*"  # only packages matching a filter
vx run test --affected          # only what changed vs the base branch
```

## 6. See what vx will do (without doing it)

```bash
vx run build --all --dry        # predicted cache hits/misses, no execution
vx run build --graph            # the task graph (text or Graphviz DOT)
```

## Where to go next

- **[Configuring tasks](../guides/tasks/)** — the full shape of
  `vx.config.ts`.
- **[Caching tasks](../guides/caching/)** — get inputs and outputs right
  so runs are always correct.
- **[Running & filtering tasks](../guides/running-tasks/)** — filters,
  `--affected`, argument forwarding, watch mode.
- **[Continuous integration](../guides/ci/)** — wire vx into CI with
  remote caching.
