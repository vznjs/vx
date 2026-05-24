# project

```ts
const ProjectSchema = z.strictObject({})
type Project = z.infer<typeof ProjectSchema>

async function loadProject(dir: string): Promise<Project>
function defineProject<T extends Project>(project: T): T
```

A zod schema, its inferred type, and two helpers around it.

- `ProjectSchema` — source of truth. Currently empty + strict; extension modules extend it via `ProjectSchema.extend({...})`.
- `Project` — type inferred from the schema. Don't write it by hand.
- `loadProject(dir)` — given a project directory, finds `vx.config.{ts,mts,js,mjs}` (first match wins, in that order), dynamic-imports it, and parses the default export through the schema. Throws if the directory has no config, or `ZodError` if the config is invalid.
- `defineProject(project)` — identity at runtime; gives type inference inside `vx.config.ts`.

The module cares about itself only — no workspace discovery, no notion of multiple projects, no knowledge of who calls it.
