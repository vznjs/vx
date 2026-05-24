# project

```ts
const ProjectSchema = z.strictObject({})
type Project = z.infer<typeof ProjectSchema>

function validateProject(input: unknown): Project
async function loadProject(dir: string): Promise<Project>
function defineProject<T extends Project>(project: T): T
```

A zod schema, its inferred type, and three helpers around it.

- `ProjectSchema` — source of truth. Currently empty + strict; extension modules extend it via `ProjectSchema.extend({...})`.
- `Project` — type inferred from the schema. Don't write it by hand.
- `validateProject(input)` — `ProjectSchema.parse(input)`. Use when you already have data (HTTP, JSON, manual construction) and need to assert it conforms.
- `loadProject(dir)` — `await import(join(dir, 'vx.config'))` and pass the default export through `validateProject`. Bun's runtime resolves the extension (`.mts` > `.ts` > `.mjs` > `.js`).
- `defineProject(project)` — identity at runtime; gives type inference inside `vx.config.ts`.

Both `validateProject` and `loadProject` throw `ZodError` on invalid input. `loadProject` also throws if the directory contains no `vx.config.*` file (Bun's "Cannot find module").

The module cares about itself only — no workspace discovery, no notion of multiple projects, no knowledge of who calls it.
