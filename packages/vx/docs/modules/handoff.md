# `src/handoff.ts` — the workspace root, and the hand-off to its vx

## Purpose

The workspace root is the directory holding the nearest `.vx/workspace.*`
from the working directory up to the git top-level, or up to `/` outside
git (2026-10-13: "Workspace file is the ultimate", "never go out
of git root"). Nothing else decides it. `findWorkspaceRoot` (workspace
module) and the hand-off both ask `workspaceFile`, once per run.

A global vx runs the project's own `@vzn/vx` when one exists
(2026-10-13): the root's `node_modules/@vzn/vx`, through its
`node_modules/.bin/vx`. This module is the compiled binary's half;
`npm-launcher.sh` does the same walk in the shell for an npm install and
`exec`s. `bin.ts` calls it before anything else loads.

## Public surface

```ts
// `vx upgrade -g`: moves only the global, so bin.ts hands nothing off
export function upgradesOnlyItself(argv: readonly string[]): boolean
// the root's own vx to run instead, or null: handed off already, not a
// standalone compiled binary (source; an npm install, whose launcher
// walked), no workspace, itself, or owned by another user than `uid`
export async function localVx(
  cwd: string,
  execPath: string,
  compiled: boolean,
  uid?: number,
): Promise<string | null>
// run it with this process's stdio and arguments, pass on a signal sent to
// this vx alone, exit with its code; die of the SIGINT, SIGTERM or SIGHUP it
// died of (another signal: 128 + signo), so a script running vx stops too
export async function handOff(bin: string, args: readonly string[]): Promise<never>
// the git top-level holding `dir` (a `.git` dir, or a worktree's `.git` file;
// a submodule's goes on to its superproject), null outside git; once per dir
export function gitTop(dir: string): Promise<string | null>
// the nearest .vx/workspace.* from `dir` up to the git top-level (or `/`
// outside git), null when none; once per directory walked
export function workspaceFile(dir: string): Promise<string | null>
// vx wrote a workspace config (`vx init`): forget what the walks learned
export function workspaceFileWritten(): void
// the six paths from the root, in lookup order (ts mts js mjs cts cjs)
export const WORKSPACE_CONFIG_FILENAMES: string[]
// the root a found `.vx/workspace.*` marks: the directory holding its `.vx`
export function workspaceRootOf(file: string): string
export function vxPath(): string // the compiled binary, else the source entry
```

## Invariants

- One hop: the child gets `VX_HANDED_OFF` (this vx's path), and a vx that
  sees it never walks. `vx --version` and the doctor (`vxPath`,
  `handedOffFrom`) report it.
- Never to itself: the launcher compares with `-ef` (a pnpm symlink is
  the same package); the binary compares realpaths.
- Never to another user's: the launcher tests `-O`, the binary the
  real file's uid. A `node_modules` planted above your checkout would
  otherwise run as you.
- The hand-off and `findWorkspaceRoot` find the same root:
  `workspaceFile` learns it once per run for both, and the workspace
  config loader reads the file it found with no second probe
  (principle 9; `tests/load-reads.test.ts`). The one write vx makes to
  it, `vx init`'s, clears what was learned, so the lock init runs next
  loads the plugins just written (`tests/init.test.ts`, "ends with the lock").
- The walk is a stat per name per level, no read but a `.git` file's
  first line, no import beyond `node:fs`: `tests/handoff.test.ts` holds
  the shapes (a local install, none, the global itself, a pnpm symlink,
  a submodule, a worktree) for both halves, and
  `tests/workspace-root-file.test.ts` the root.
- The vx that hands off waits out the run beside its tasks, so it hides
  its env first (`util/hide-env`), as every verb does; it never reaches
  the verb that would (`tests/hide-env.unsafe.test.ts`).
