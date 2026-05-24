# workspace

Discovers projects on disk and returns a `Workspace` (root + list of `Project`).

## Contract

```ts
type Discover = (opts: { root: string }) => Promise<Workspace>
```

A `Project` has `{ name, dir }` — nothing else. Anything else a project carries (tasks, package deps, …) is loaded by downstream modules from `dir`.

## Default implementation: `discover`

Discovery order at `root`:

1. **`pnpm-workspace.yaml`** — uses `packages: [...]` globs.
2. **`package.json` `workspaces`** — npm/yarn/bun-style, accepts a flat array or `{ packages: [...] }`.
3. **Bare `package.json`** — root itself is the single project.

Each candidate directory must contain a `package.json` with a `name` field; directories without one are skipped silently (typical for tooling-only folders matched by a glob).

## Replacing it

Anyone can implement `Discover` and pass it to higher-level modules. Use cases:

- Bazel-style explicit project list from a manifest
- Discovery from a database (monorepo metadata service)
- A flat directory layout where every subdirectory is a project
