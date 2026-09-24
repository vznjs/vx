# `src/orchestrator/sandbox-request.ts` — the sandbox half of a request

## Purpose

What a sandboxed task may read and write, where denials are reported,
and the filesystem groundwork a bind needs. Built once per attempt by
`execute-task.ts` for the cached path (handed to the executor inside
the `ExecuteRequest`) and the persistent path (spawned in place).
Moved out of `execute-task.ts` on 2026-09-09 as pure code motion: the
concern has no cache-key or save logic in it.

## Public surface

```ts
export interface SandboxArmer {
  arm(): Promise<void>
  readonly armed: boolean
}
export function prepareSandbox(nodes: Iterable<TaskNode>): SandboxArmer | null

export interface SandboxRunUnion {
  domains: string[] // every sandboxed task's `allow.network` list, deduped
  unixSockets: boolean // SRT's all-or-nothing AF_UNIX filter, lifted for the run
  weakerNested: boolean // true only when EVERY sandboxed task accepts it
}
export function sandboxRunUnion(nodes: Iterable<TaskNode>): SandboxRunUnion | null

export interface SandboxRequest {
  sandbox: NonNullable<ExecuteRequest['sandbox']> // the request's sandbox half
  placeholders: Placeholder[] // the empty files created for a literal write grant that named nothing yet
  withheld: WithheldLink[] // the linked packages a cached task was denied
}
export interface Placeholder {
  path: string
  mtimeMs: number // as created; a later mtime means the task wrote it
}
export interface WithheldLink {
  dir: string // the canonical target, inside the workspace root
  name: string // the name it is installed under (`@x/ui`)
  target: string // workspace-relative POSIX, for the hint
  link: string // workspace-relative POSIX, for the hint
}
export async function sandboxRequestFor(
  node: TaskNode,
  sandbox: NonNullable<ExecConfig['sandbox']>,
  workspaceRoot: string,
  keyed: ReadonlySet<string> | undefined, // keyed-projects.ts's set; undefined for a task with no `cache`
): Promise<SandboxRequest>

export async function sweepPlaceholders(placeholders: readonly Placeholder[]): Promise<string[]>
export function untouchedPlaceholderLine(projectDir: string, placeholder: string): string
export function reachedWithheld(
  withheld: readonly WithheldLink[],
  violations: readonly SandboxViolation[],
): WithheldLink[]
export function withheldLinkLine(taskId: string, w: WithheldLink): string
```

- `prepareSandbox` prepares the runtime for a run when any task opts
  in; null when none did. Starting it is `arm()`, called by
  execute-task on the FIRST task that executes inside a sandbox and
  memoized — a run of cache hits never probes or starts anything.
  `arm()` refuses (`UserError`) when a task needs a sandbox the
  platform lacks, and a throw from the runtime itself (its bridge
  needs `socat`, which the dependency check does not cover; a temp
  directory it cannot write) is the same one-line verdict, never a
  stack. The proxy allowlist is the union of every sandboxed task's
  domains, and the unix-socket allowance (a `localBinding` port list,
  or `unixSockets`) is armed for the run the same way — the runtime
  reads both at `initialize()` only.
- `sandboxRunUnion` is that fold, split out so it can be READ without
  starting a sandbox: the `initialize()` call itself is observable only
  through a live runtime, so what it carries had no witness of any kind
  and three separate widenings of it survived a whole-suite mutation
  sweep (item 537). `network: true` is deliberately absent from
  `domains` — it SKIPS the proxy rather than passing through it, so
  folding it in as `*` would widen the allowlist every other task in the
  run is filtered against. An empty `unixSockets` list means none, and
  `weakerNested` takes EVERY, so one task's opt-in cannot weaken the
  profile the others run under.
- `sandboxRequestFor` builds the sandbox half of one request, plus the
  placeholders.
- `sweepPlaceholders` removes the placeholders the task never wrote
  (still empty, mtime untouched) and returns their paths. execute-task
  calls it after every attempt of a one-shot task, and when a
  persistent task's child exits (or fails to become ready); a failed
  task with nothing else reported gets one line per untouched
  placeholder (`untouchedPlaceholderLine`).
- `reachedWithheld` names the withheld packages a reported denial lies
  under; execute-task appends `withheldLinkLine` for each, beside the
  denial (so never on a pass): the package, the link the task went
  through, and the two ways to make the key answer for it.

## Rules

- **The user's grants derive nothing from `cache`.** `cache.inputs`
  says what INVALIDATES a task; `sandbox.allow` says what it may TOUCH.
  A sandboxed task declares its own reads and writes.
- **`node_modules` is the one grant core makes** — the project's and
  the workspace root's, plus the real path of every workspace link in
  them (one level, and one level inside `@scope/`): a dependency is
  not a reach-out. Never a link to the task's own project or a
  directory holding it.
- **Declaring `cache` may narrow that grant, never widen one**
  (2026-09-24). For a task with `cache`, a link target inside the
  workspace root is granted only when it IS the directory of a project
  in `keyed` (keyed-projects.ts: the projects whose tasks the key folds);
  every other one is withheld. A target outside the root is outside the
  deny anchor, so granting it is a no-op. Both sides of every comparison
  are canonical (a root reached through a link, macOS's `/var`). A task
  with no `cache`, and every persistent task, keeps the whole grant.
- **Enforcement anchors at the workspace root, reporting at the
  project and the withheld packages.** Every sibling and root file is
  denied; only denials inside the project's own directory, or under a
  withheld package (`reportLinked`), are reported, because those are
  the reads the cache key never folded.
- **Binds need paths.** bwrap silently no-ops a bind on a missing path,
  so declared write paths are pre-created: a glob's static prefix or a
  literal ending in `/` as a directory, any other literal as an empty
  file unless something is already there; a grant outside the project
  (`~/…`, absolute) only when it is a glob. The empty files are vx's
  until the task writes them: the sweep after the attempt removes the
  untouched ones (an unwritten placeholder is never archived as an
  output), and a failed task is told that a grant it meant as a
  directory is spelled `dir/` — its own `mkdir` said only "File exists",
  and the file used to survive every later clean (2026-09-16).

## Tests

`tests/sandbox*.unsafe.test.ts` (the sandbox cannot nest, so the CI
job runs them with `VX_REQUIRE_SANDBOX=1`); `tests/sandbox-request.test.ts`
for the pre-created paths, the sweep and the exact link grant (uncached,
keyed, keyed on nothing, each through a symlinked root);
`tests/execute-task*.test.ts` for the request shape.
