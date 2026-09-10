# @vzn/vx-prune

A self-contained SUBSET of a [`@vzn/vx`](https://github.com/vznjs/vx) workspace for Docker builds (Turbo `turbo prune` parity): one project plus its transitive workspace dependencies, the root manifests rewritten to the subset, any `vx.workspace.*`, and the lockfile. Zero dependencies.

Two ways in, one body:

```bash
bunx @vzn/vx-prune <project> [--out-dir <dir>] [--docker]   # no workspace file needed
vx prune <project> [--out-dir <dir>] [--docker]             # the verb, when the workspace declares the plugin
```

```ts
// vx.workspace.ts
import { prune } from '@vzn/vx-prune'
export default { plugins: [prune()] }
```

## What lands in the output

- `pnpm-workspace.yaml` is REWRITTEN to the exact subset dirs — a glob matching absent dirs breaks installs — and so is `package.json`'s `workspaces` field, where bun, npm and yarn read membership. A glob that matches nothing is tolerated; an entry naming an exact directory the subset lacks is fatal (`bun install` → `Workspace not found`), so both array and `{ packages: [...] }` forms are rewritten, a `"."` entry preserved, the rest of the manifest untouched.
- The lockfile is copied **unpruned**: every package manager tolerates a superset lockfile, and a wrongly pruned one is worse than a big correct one.
- `node_modules`, `.git`, `.vx` and `.turbo` are excluded from the copy.
- `--docker` splits the output into `json/` (root files + each package's `package.json` only — `COPY` this first so the install layer caches independently of source edits) and `full/` (the sources):

```dockerfile
COPY out/json/ .
RUN pnpm install --frozen-lockfile
COPY out/full/ .
RUN pnpm vx run build
```

## What the configs pull in

The subset is the package graph plus one thing the package graph does not know about: a workspace package that `vx.workspace.*` **imports**. The workspace config loads before any task, so a plugin living in a workspace package is as load-bearing as a dependency; those packages (and their own closure) are added.

Runnability is otherwise **not** guaranteed, and prune says so rather than pretending: a relative import escaping its own package, or an import of the workspace ROOT package (which cannot be copied into a subset because it _is_ the workspace), is a warning on stderr. The scan is static (`from '…'`, `import '…'`, `import('…')`), so a computed specifier is invisible to it.

## History

Core's own `vx prune` from 2026-08-25 to 2026-09-10, when it became this package so core ships nothing that is not orchestration. `vx prune` in a workspace that does not declare the plugin prints the pointer here.
