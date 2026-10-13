# `src/handoff.ts` — a global vx hands off to the project's own

## Purpose

A global vx runs the project's own `@vzn/vx` when one exists (owner,
2026-10-13): the first `node_modules/@vzn/vx` from the working directory
up to the git root, through its `node_modules/.bin/vx`. This module is
the compiled binary's half; `npm-launcher.sh` does the same walk in the
shell for an npm install and `exec`s. `bin.ts` calls it before anything
else loads.

## Public surface

```ts
// the local vx to run instead, or null: handed off already, not a standalone
// compiled binary (source; an npm install, whose launcher walked), or itself
export function localVx(cwd: string, execPath: string, compiled: boolean): string | null
// run it with this process's stdio and arguments, pass on a signal sent to
// this vx alone, exit with its code (128 + signo for a signal)
export async function handOff(bin: string, args: readonly string[]): Promise<never>
export function vxPath(): string // the compiled binary, else the source entry
```

## Invariants

- One hop: the child gets `VX_HANDED_OFF` (this vx's path), and a vx that
  sees it never walks. `vx --version` and the doctor (`vxPath`,
  `handedOffFrom`) report it.
- Never to itself: the launcher compares with `-ef` (a pnpm symlink is
  the same package); the binary compares realpaths.
- The walk is a stat per level, no read, no import beyond `node:fs`:
  `tests/handoff.test.ts` holds the shapes (a local install, none, the
  global itself, a pnpm symlink) for both halves.
