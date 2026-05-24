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
- `loadProject(dir)` — `await import(join(dir, 'vx.config'))`, then parse through the schema. Bun's runtime resolves the extension natively (`.mts` > `.ts` > `.mjs` > `.js`). Throws if no config exists or `ZodError` if invalid.
- `defineProject(project)` — identity at runtime; gives type inference inside `vx.config.ts`.

The module cares about itself only — no workspace discovery, no notion of multiple projects, no knowledge of who calls it.
