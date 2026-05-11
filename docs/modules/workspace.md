# `workspace.ts` — pnpm workspace discovery

## Purpose

Find the workspace root, parse `pnpm-workspace.yaml`, and enumerate
every package in the workspace.

## Public surface

```ts
export interface PackageJson {
  name: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

export interface Workspace {
  root: string
  packageGlobs: string[]
}

export interface ProjectMeta {
  name: string
  dir: string
  packageJson: PackageJson
  configPath: string | null // absolute path or null if no vzn.config.*
}

export function findWorkspaceRoot(start: string): string
export async function loadWorkspace(root: string): Promise<Workspace>
export async function listProjects(workspace: Workspace): Promise<ProjectMeta[]>
```

## Discovery rules

1. **`findWorkspaceRoot(cwd)`** walks parent directories looking for
   `pnpm-workspace.yaml`. Throws if it hits the filesystem root with
   no match.

2. **`loadWorkspace(root)`** reads + parses the YAML. Recognized fields:
   `packages: string[]`. Other fields are ignored. Empty / missing
   `packages` field is OK (returns `packageGlobs: []`).

3. **`listProjects(workspace)`** globs `<each glob>/package.json` to
   find candidate package directories. For each:
   - Reads `package.json`; if no `name` field, the package is skipped
     entirely (not even listed).
   - Throws on duplicate `package.json#name` across the workspace,
     citing both directories.
   - Looks for `vzn.config.{ts,mts,js,mjs}` in the package directory.
     The first matching file is the `configPath`; if none exists,
     `configPath` is `null` (the project is discovered but contributes
     no tasks).
   - Results are sorted by name for deterministic ordering.

## What this does NOT do

- It doesn't load config files — that's `project-loader.ts`.
- It doesn't build the dep graph — that's `package-graph.ts`.
- It doesn't follow symlinks specially — globbing is via `tinyglobby`
  with `node_modules` ignored.
- It doesn't support yarn / npm workspaces. Hard-coded to
  `pnpm-workspace.yaml` discovery.

## Tests

`workspace.test.ts` covers:

- `findWorkspaceRoot` walks up; throws when nothing found.
- `listProjects` skips packages with no `name`.
- `listProjects` handles an empty workspace yaml gracefully.

`orchestrator.test.ts` exercises the integration path (every e2e test
discovers via this module) and the duplicate-name error.

## Replacing this module

To support yarn / npm / lerna / custom workspaces, replace
`findWorkspaceRoot` + `loadWorkspace` + `listProjects` with equivalents
that produce the same `Workspace` and `ProjectMeta` shapes. Everything
else in the codebase consumes those types.

The `Workspace.packageGlobs` field is exposed but currently only used
internally by `listProjects` — keep it for now in case a future
workspace fingerprinting strategy wants to include it.
