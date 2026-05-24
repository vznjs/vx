# project

```ts
const ProjectSchema = z.strictObject({})
type Project = z.infer<typeof ProjectSchema>

async function loadProject(path: string): Promise<Project>
function defineProject<T extends Project>(project: T): T
```

A zod schema, its inferred type, and two helpers around it.

- `ProjectSchema` — the source of truth. Currently empty + strict; extension modules extend it via `ProjectSchema.extend({...})`.
- `Project` — the type, inferred from the schema. Don't write the type by hand.
- `loadProject(path)` — dynamic-imports the path and `.parse()`s the default export through the schema. Throws `ZodError` on invalid input.
- `defineProject(project)` — identity at runtime; gives type inference inside `vx.config.ts`.

The module cares about itself only — no file discovery, no extension iteration, no knowledge of who calls it.
