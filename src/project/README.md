# project

```ts
type Project

async function loadProject(dir: string): Promise<unknown>
function validateProject(input: unknown): Project
function defineProject<T extends Project>(project: T): T
```

Three functions and a type. Internally the type is inferred from a zod schema (currently empty + strict); the schema itself is module-private.

- `Project` — the type. Currently `{}`. Don't write it by hand.
- `loadProject(dir)` — `await import(join(dir, 'vx.config'))` and return the default export. No validation. Bun's runtime resolves the extension (`.mts` > `.ts` > `.mjs` > `.js`). Throws if the directory has no config file.
- `validateProject(input)` — parses any value through the schema. Throws `ZodError` on mismatch.
- `defineProject(project)` — identity at runtime; gives type inference inside `vx.config.ts`.

Load and validate are separate by design. Compose them at the call site:

```ts
const project = validateProject(await loadProject(dir))
```

The module cares about itself only — no workspace discovery, no notion of multiple projects, no knowledge of who calls it.
