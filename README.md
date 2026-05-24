# @vzn/vx

Pre-alpha. Two modules: `src/project/` and `src/workspace/`.

```ts
import {
  defineProject,
  loadProject,
  validateProject,
  defineWorkspace,
  loadWorkspace,
  validateWorkspace,
  findWorkspaceRoot,
} from '@vzn/vx'

// In vx.config.ts:
export default defineProject({})

// In vx.workspace.ts:
export default defineWorkspace({})

// Anywhere else:
const root = await findWorkspaceRoot(process.cwd())
const workspace = await loadWorkspace(root)
const project = await loadProject('/abs/path/to/project-dir')
```

Both modules ship the same shape: a zod-validated type, plus `load` / `validate` / `define`. The workspace module also exposes `findWorkspaceRoot(start)` (powered by `pkg-types`) that walks up from a path to the workspace root.

See [`src/project/index.ts`](src/project/index.ts) and [`src/workspace/index.ts`](src/workspace/index.ts).

## Develop

```bash
bun install
bun test
bun x oxfmt --check .
bun x oxlint --type-aware --type-check
bun tests/project.bench.ts
bun tests/workspace.bench.ts
```

## License

[MIT](LICENSE).
