# `src/orchestrator/run-context.ts` — git/CI/host capture

## Purpose

The per-run context for the `invocations` header row and the telemetry
`RunContextRecord`: commit, branch, dirty, CI provider, host/os/arch —
and, for the telemetry schema's multi-workspace story, a stable
workspace identity and the repository's default branch.

## Public surface

```ts
export interface GitContext {
  commitSha: string | null // HEAD's commit, or null outside a repo / on failure
  branch: string | null // HEAD's branch, or null when detached
  dirty: boolean | null // passed in by the caller; null when unknown
}
export interface CiContext {
  ci: boolean
  provider: string | null // 'github' | 'gitlab' | 'buildkite' | 'circleci' | 'generic' (bare `CI`), or null
}
export interface HostContext {
  host: string | null
  os: string
  arch: string
}
export interface WorkspaceIdentity {
  id: string // stable 16-hex id — the same for every checkout of the same repo
  name: string // the repo (or root dir) basename
}

export function captureGitContext(
  workspaceRoot: string,
  dirty?: boolean | null,
  env?: NodeJS.ProcessEnv,
): GitContext
export function captureDefaultBranch(env: NodeJS.ProcessEnv, workspaceRoot: string): string | null
export function detectCi(env: NodeJS.ProcessEnv): CiContext
export function captureHostContext(): HostContext
export function normalizeRemoteUrl(raw: string): string
export function captureWorkspaceIdentity(workspaceRoot: string): WorkspaceIdentity
```

- `captureGitContext(root, dirty, env)` — reads `HEAD` from the `.git`
  files first (a `.git` directory or a linked worktree's `gitdir:` file,
  a symbolic or detached HEAD, loose refs and `packed-refs`): no spawn
  on a familiar layout. Anything unfamiliar falls back to ONE
  `git rev-parse HEAD --abbrev-ref HEAD` spawn (commit on line 1, branch
  on line 2), behind try/catch. A detached HEAD takes the branch the CI
  environment names, when one does. `dirty` is passed in — the run's
  `GitFilesCache` populate already ran `git status --porcelain`, so no
  second status spawn. Each field degrades to null independently.
- `captureDefaultBranch(env, root)` — the branch whose runs feed the
  shared scheduling baseline (an experiment on a branch must not count
  into main). Ladder: GitLab's `CI_DEFAULT_BRANCH`; GitHub Actions'
  event payload (`repository.default_branch`, one best-effort JSON
  read); else `git symbolic-ref --short refs/remotes/origin/HEAD` with
  the `origin/` prefix stripped. Null when none resolve — the consumer
  then counts every run. Never throws.
- `detectCi(env)` — the provider matrix, first truthy variable wins
  (present and not `0` / `false`): `github`, `gitlab`, `buildkite`,
  `circleci`, and a bare `CI` as `generic`.
- `captureHostContext()` — hostname/os/arch.
- `captureWorkspaceIdentity(root)` — the same id from any machine's
  checkout of the same repo: the `origin` remote URL normalized
  (`normalizeRemoteUrl`: `git@github.com:o/r.git`,
  `ssh://git@github.com/o/r` and `https://github.com/o/r.git` all
  reduce to `github.com/o/r`) and hashed; no remote → a salt persisted
  at `<root>/.vx/workspace-id`; an unwritable `.vx/` → the root path
  itself. One `git` spawn behind try/catch, called only when telemetry
  is active. Never throws.

## Invariants

- A plain run pays no git spawn here: the context reads `.git` directly,
  and the identity is captured only for a telemetry-bearing run (one
  spawn then, two if `.git` is unfamiliar). Never fails a run.
