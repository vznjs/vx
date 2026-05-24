# graph

Builds the task DAG from loaded project configs + a list of requested tasks.

## Contract

```ts
type BuildGraph = (opts: {
  configs: readonly LoadedConfig[]
  requested: readonly string[]
}) => TaskGraph
```

`TaskGraph.nodes` is in **topological order** — running them in array order respects all `dependsOn` edges. Sequential consumers can iterate; parallel schedulers consume the same array + the `dependencies` field to gate ready tasks.

## Dependency syntax

`dependsOn` entries use the Turbo/Nx micro-syntax (parsed by `dependency-spec.ts`):

| Form               | Meaning                             | Status                                  |
| ------------------ | ----------------------------------- | --------------------------------------- |
| `name`             | Same-project task `name`.           | Shipped                                 |
| `pkg#name`         | Specific package's `name` task.     | Shipped                                 |
| `^name`            | `name` task in every workspace dep. | Deferred (needs `package-graph`)        |
| `*`, `^*`, `!form` | Wildcards + negation.               | Filter-only — not valid in `dependsOn`. |

## Errors (fail loud)

- Requested task no project declares → `GraphError`.
- Same-project dep referencing a missing task → `GraphError`.
- Cross-project dep referencing a missing project or task → `GraphError`.
- `^name` until `package-graph` ships → `GraphError`.
- Cycle in the DAG → `GraphError` (lists the cycle path).

## Sub-modules

- `dependency-spec` — the parser. Pure. No FS, no graph state.
- `build` — graph assembly + cycle check + topo sort.
- `format` — text / JSON / DOT renderers for `vx graph` CLI.
