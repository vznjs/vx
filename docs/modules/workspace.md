# `src/workspace/workspace.ts` — workspace discovery

## Purpose

Find the workspace root, enumerate its projects, and resolve the
cache directory. Supports pnpm / npm / yarn / Bun workspaces, plus a
single-project mode (bare `package.json` with no `workspaces` field).

## Public surface

```ts
export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

export interface Workspace {
  root: string
  packageGlobs: string[] // patterns relative to root
}

export interface ProjectMeta {
  name: string // canonical from package.json
  dir: string // absolute project directory
  packageJson: PackageJson
  configPath: string | null // absolute path to vx.config.{ts,mts,js,mjs}
}

export function findWorkspaceRoot(start: string): Promise<string>
export function loadWorkspace(root: string): Promise<Workspace>
export function listProjects(workspace: Workspace): Promise<ProjectMeta[]>
export function resolveCacheDir(root: string, config: WorkspaceConfig | null): string
```

## Discovery rules

### `findWorkspaceRoot(start)`

Walks up from `start` to the filesystem root. A directory is a
workspace root if it contains either:

- `pnpm-workspace.yaml`, OR
- `package.json` (with or without a `workspaces` field).

**First match wins.** A bare `package.json` without `workspaces` means
single-project mode — the root itself IS the project. Throws a
`UserError` if neither signal is found.

### `loadWorkspace(root)`

Reads the package-glob list:

| Manager                | Source                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| pnpm                   | `pnpm-workspace.yaml`'s `packages:` field (via `Bun.YAML.parse`) |
| npm / yarn / bun (new) | `package.json` `workspaces: string[]`                            |
| yarn (legacy)          | `package.json` `workspaces: { packages: string[] }`              |
| single project         | `package.json` without `workspaces` → returns `['.']`            |

### `listProjects(workspace)`

Globs every `package.json` matching the patterns (`Bun.Glob`,
`onlyFiles: true`, `dot: false`). For each:

- Skip if no `name` field.
- Detect duplicate package names → throws `UserError` with both
  paths.
- Find the first existing `vx.config.{ts,mts,js,mjs}` sibling; that
  becomes `configPath`. Projects without a config keep
  `configPath: null` — they're still in the workspace graph (so
  cross-package deps work) but contribute no tasks.
- `node_modules` paths are explicitly skipped even when a
  pathological `**` glob would match them.

Returns the project list sorted by `name`.

### `resolveCacheDir(root, config)`

Resolves the cache directory:

- `config?.cacheDir` (set via `vx.workspace.ts`) is honored.
  Relative paths resolve against `root`; absolute paths pass through.
- Default: `<root>/.vx/cache`.

Used by `orchestrator.run` and `planRun`. `vx cache prune` currently
uses the default path directly — workspace-config cacheDir override
isn't yet wired through the prune path.

## What this does NOT do

- **Doesn't load configs.** `loadProjectConfig` does (see
  [`project-loader.md`](./project-loader.md)). Discovery is purely
  about "what packages exist and where?"
- **Doesn't compute the package graph.** That's
  [`package-graph.md`](./package-graph.md).
- **Doesn't filter projects.** `--filter` / `--affected` happen in
  `cli/run.ts`.
- **Doesn't enforce project boundaries.** `inputs.ts` does, using
  the nested-dirs precomputation.

## Tests

`tests/workspace.test.ts`:

- pnpm-workspace.yaml discovery.
- npm/yarn/bun `workspaces` array form.
- yarn legacy `workspaces.packages` form.
- bare-`package.json` single-project mode (`['.']`).
- duplicate-name detection.
- `findWorkspaceRoot` ascending behavior + missing-root error.
- glob behavior (one project, multiple projects, nested
  `node_modules` skipped).

## Replacing this module

- **Lerna / Rush layouts** — replace `loadWorkspace` to parse the
  appropriate config file. Keep `Workspace` shape.
- **Custom workspace yaml** — add another source to `loadWorkspace`.
- **Project discovery beyond `package.json`** — e.g., reading
  `pyproject.toml` for non-JS deps. Would require generalizing
  `ProjectMeta.packageJson` into a more abstract `manifest` field.
