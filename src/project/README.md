# project

```ts
async function loadProject(path: string): Promise<Project>
function defineProject<T extends Project>(project: T): T
interface Project {}
```

Two functions and an empty type. The module cares about itself only — no file discovery, no extension iteration, no validation, no schema, no knowledge of who calls it.

- `loadProject(path)` — dynamic-import the path, return `mod.default`.
- `defineProject(project)` — identity at runtime; gives type inference inside `vx.config.ts`.
- `Project` — empty interface. Schema fields will be added by future modules that own them.
