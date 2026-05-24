# inventory

Produces the JSON workspace inventory that `vx graph` emits.

## Why a separate module from `graph`

The `graph` module resolves `dependsOn` into a concrete DAG — it needs the package-graph to handle `^name` edges, runs cycle detection, topo-sorts. The inventory module is much cheaper: it just walks the discovered projects and their declared tasks, emitting raw `dependsOn` strings without resolution.

Keeping them separate means:

- AI consumers get a stable, lossless dump of the user's configuration regardless of whether resolution would succeed.
- `vx graph` can't fail with "package-graph not shipped" or "cycle detected" — those are concerns for the runner.
- Both modules can evolve independently. When the runner ships, `inventory` can grow a `resolvedDependencies` field; right now it stays minimal.

## Contract

```ts
type BuildInventory = (opts: {
  workspace: Workspace
  configs: readonly LoadedConfig[]
}) => Inventory

interface Inventory {
  workspace: { root: string }
  projects: Array<{
    name: string
    dir: string
    targets: Array<{
      name: string
      description?: string
      command?: string // omitted for group tasks
      dependsOn?: string[] // raw, unresolved
    }>
  }>
}
```

## Notes

- Projects without a `vx.config.ts` are still emitted, with `targets: []`. The CLI consumer can tell the user "I saw the package but it declared no tasks".
- `targets` are emitted in `vx.config.ts` declaration order (insertion order of the `tasks` object) — preserves intent.
- Projects are sorted by directory for stable output across runs.
