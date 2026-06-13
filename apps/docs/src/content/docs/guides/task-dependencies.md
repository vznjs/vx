---
title: Task dependencies
description: Wire tasks together with dependsOn — same-package, the ^ workspace-deps prefix, and explicit pkg#task edges. How vx builds the graph across your monorepo.
---

`dependsOn` declares what must finish before a task runs. vx uses those
declarations plus your `package.json` `dependencies` to build one
dependency graph for the whole run, then executes it in topological order
with bounded parallelism.

The syntax is the Turborepo/Nx micro-syntax — if you're coming from
either, it's identical.

## The three forms

```ts
dependsOn: ['codegen']             // same-package task
dependsOn: ['^build']              // same task in workspace dependencies
dependsOn: ['shared#build']        // a specific package's task
```

| Form         | Meaning                                                            |
| ------------ | ----------------------------------------------------------------- |
| `'name'`     | Task `name` **in this same package**. Must exist or it's an error. |
| `'^name'`    | Task `name` in this package's **workspace dependencies**.          |
| `'pkg#name'` | Task `name` in **package `pkg`** specifically.                     |

You can mix them:

```ts
dependsOn: ['codegen', '^build', 'shared#test']
```

## Same-package ordering

Use the bare form to sequence steps within a package — useful when you
want each step cached independently:

```ts
tasks: {
  codegen: {
    exec: { command: 'graphql-codegen' },
    cache: { inputs: { files: ['schema.graphql'] }, outputs: { files: ['src/gen/**'] } },
  },
  build: {
    dependsOn: ['codegen'],
    exec: { command: 'tsc -b' },
    cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
  },
}
```

## Across the workspace: the `^` prefix

`'^build'` means "run `build` in each of my workspace dependencies
first." vx reads which packages you depend on from your `package.json` —
you don't redeclare the graph. This is the backbone of monorepo builds:

```ts
build: {
  dependsOn: ['^build'],
  exec: { command: 'tsc -b' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
}
```

### Sparse tasks are bridged automatically

Not every package declares every task. If `app` depends on `ui`, and
`ui` depends on `core`, but only `core` declares `build`, then `app`'s
`^build` reaches **through** `ui` to `core` — the nearest dependency that
actually holds the task. Turborepo and Nx stop at direct dependencies;
vx bridges sparse coverage so you don't have to add no-op tasks
everywhere.

The holder is responsible for ordering deeper than itself — so chain
`^build` in each builder (the universal pattern) and the cascade flows
all the way down.

## Explicit cross-package edges

When you need a specific edge that isn't a normal dependency
relationship, name it directly:

```ts
e2e: {
  dependsOn: ['app#build', 'api#build'],
  exec: { command: 'playwright test' },
}
```

A missing package or task here is a hard error — you named them, so a
typo should fail loudly.

## Ordering vs. cache identity

`dependsOn` does two things at once: it **orders** execution, and by
default it folds the upstream's hash into this task's **cache key**.
Sometimes you want the ordering but not the key coupling — e.g. an
integration test that must run *after* a dev server starts but whose
result doesn't depend on it. Separate them with `cache.inputs.tasks`:

```ts
e2e: {
  dependsOn: ['dev'],            // ordering only
  exec: { command: 'playwright test' },
  cache: {
    inputs: { files: ['e2e/**'], tasks: [] },   // dev's hash is not part of e2e's key
    outputs: { files: ['playwright-report/**'] },
  },
}
```

See [Caching tasks](../caching/#cascading-through-dependencies) for the
filter syntax.

## Failures and cycles

- **A failed task aborts its transitive dependents** but lets independent
  siblings continue (Turborepo's middle behavior).
- **Cycles are detected** when the graph is built and reported with the
  offending path — no infinite loops, no silent deadlock.
- **Wildcards and negation** (`*`, `^*`, `!task`) are **not** allowed in
  `dependsOn` — they belong in `cache.inputs.tasks`, which filters cache
  keys rather than declaring edges.

## Visualizing the graph

```bash
vx run build --graph              # text view of the resolved graph
vx run build --graph=graph.dot    # Graphviz DOT for rendering
```

## Next steps

- **[Running & filtering tasks](../running-tasks/)** — scope a run to
  part of the graph.
- **[Caching tasks](../caching/)** — how upstream hashes cascade.
- **[Dev & long-running tasks](../dev-tasks/)** — depending on a dev
  server.
