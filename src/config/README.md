# config

Defines `ProjectConfig` and loads `vx.config.{ts,mts,js,mjs}` files. No validation, no schema enforcement — whatever the user `export default`s is what comes back.

## Contract

```ts
type LoadConfigs = (sources: readonly ConfigSource[]) => Promise<readonly LoadedConfig[]>

interface ConfigSource {
  name: string // identifier (typically the package name)
  dir: string // directory to look in
}

interface ProjectConfig {} // intentionally empty
interface LoadedConfig {
  source: ConfigSource
  config: ProjectConfig
}
```

Sources without a config file in their directory are silently omitted from the result.

## Default impl

For each source, in parallel:

1. Look for `vx.config.ts`, then `.mts`, then `.js`, then `.mjs` in `source.dir`. First match wins.
2. `import(path)`. Return `{ source, config: mod.default }`.

No validation. Bad inputs produce undefined behavior downstream — that's a feature, not a bug. Adding validation is the next module's problem when there's a schema to validate against.
