# config

Loads `vx.config.{ts,mts,js,mjs}` from each discovered project and validates the base schema.

## Contract

```ts
type LoadConfigs = (opts: {
  workspace: { projects: readonly Project[] }
}) => Promise<readonly LoadedConfig[]>
```

A `LoadedConfig` pairs a `Project` with its parsed `ProjectConfig`. Projects without a config file are omitted (a project that declares no tasks contributes nothing to the graph).

## Schema (minimal — base surface)

```ts
interface ProjectConfig {
  tasks?: Record<string, TaskConfig>
}

interface TaskConfig {
  description?: string
  exec?: { command: string }
  dependsOn?: readonly string[]
}
```

Extension modules (cache, sandbox, watch) add fields by reading them off the underlying object — the loader allows unknown fields and never errors on them. Strict validation only covers the base surface above.

## Default implementation: `loadConfigs`

Uses Bun's native TS-as-source import. For each project dir, looks for `vx.config.ts`, then `.mts`, `.js`, `.mjs` in that order. The first one found is `await import(...)`d and its `default` export is validated.

A config that fails validation throws — this is a fail-loud module. Authors should see typos immediately, not at task-run time.

## Replacing it

Anyone can implement `LoadConfigs`. Use cases: load configs from a database; convert turbo.json on the fly; declarative YAML configs.
