# `src/util/errors.ts` — clean error reporting

## Purpose

Distinguish user-input failures (config errors, missing refs, malformed
flags) from internal bugs (assertion failures, unexpected nulls).
Surfaces user errors as plain messages without a stack trace; internal
errors keep the stack so we can debug them.

## Public surface

```ts
export class UserError extends Error {
  readonly code: string // VX_E_…, default VX_E_REFUSED
  constructor(message: string, code?: string)
}
export function isUserError(err: unknown): err is UserError // by name, across a copy boundary (below)
export function errorCode(err: unknown): string // the stable code of anything bin.ts catches
export function wantsJson(argv: readonly string[]): boolean // --format json, --format=json, --dry=json, before `--`
export function errorDocument(code: string, message: string): string // `{"ok":false,"error":{code,message}}` + newline

// The environment's refusals, reported like a UserError — one line naming the path, never a stack:
export function isPermissionError(err: unknown): err is NodeJS.ErrnoException // EACCES, EPERM, EROFS
export const PERMISSION_HINT: string
export function isDiskFull(err: unknown): err is NodeJS.ErrnoException // ENOSPC, EDQUOT
export const DISK_FULL_HINT: string
export function isFsRefusal(err: unknown): err is NodeJS.ErrnoException // either of the two
export function fsRefusalHint(err: NodeJS.ErrnoException): string
export function isOutOfFds(err: unknown): err is NodeJS.ErrnoException // EMFILE, ENFILE
export const OUT_OF_FDS_HINT: string // "raise the limit (ulimit -n 4096)"
export function isTmpdirRefusal(err: unknown): err is NodeJS.ErrnoException // a path under os.tmpdir() missing, a file, or unwritable
export const TMPDIR_HINT: string // "point TMPDIR at a writable directory"

export function isExecutableMissing(err: unknown): boolean // Bun's ENOENT for a spawn that could not run at all
export function gitSpawnRefusal(cwd: string): UserError // the one refusal for a git that is not on PATH
export function notAWorkTree(cwd: string, stderr?: string): UserError // the one refusal for a directory git does not track
```

`UserError` instances have `.name === 'UserError'`. `bin.ts` prints
`err.message` for anything `isUserError` admits; a file-system refusal
(`isFsRefusal`) as its message plus `fsRefusalHint`; a process out of
file descriptors (`isOutOfFds`) as its message plus `OUT_OF_FDS_HINT`;
anything else with
its stack. Every one sets exit code 1 — nothing is re-thrown. When the
argv asks for JSON (`wantsJson`), `bin.ts` also prints `errorDocument`
on stdout with `errorCode`: a UserError's own code (`VX_E_CONFIG` for a
codeless one that opens with its config file), `VX_E_FDS`, `VX_E_FS`,
or `VX_E_INTERNAL`. The codes are listed in `cli.md` § Error codes.
`isTmpdirRefusal` is not `bin.ts`'s: the sandbox runtime and the run
lock ask it and add `TMPDIR_HINT` to their own message, because a
minimal image's sandboxed task once said only "EACCES … mkdtemp"
(2026-09-16).

## Convention

Throw `UserError` whenever the cause is user input or environment
state the user can fix without code changes:

- Malformed `vx.config.ts` (validated in `project-loader.ts`).
- Missing workspace root (`findWorkspaceRoot`).
- Bad git ref for `--affected` (`workspace/affected.ts`).
- Cycle in the task graph (`graph/task-graph.ts`).
- Duplicate package names, one of them with a vx config (`workspace.ts`).
- Bad CLI flags (in `cli/run.ts`).

Throw plain `Error` (or let TypeError / RangeError propagate) for
internal bugs — those should show a full stack so we can find them.

## Tests

`tests/errors.test.ts` — verifies the `name` field, basic shape.
Real coverage comes from every module's "bad input" tests.

## `isUserError(err)`

`instanceof UserError`, plus the same class arriving from **another copy of
core**. A compiled `vx` binary carries core inside it while a workspace
plugin imports `@vzn/vx` from `node_modules`, so a plugin's `UserError` is a
different class object and `instanceof` is false across the boundary — a
plugin verb's refusal printed with a stack, and a REAPI refusal would have
read as an "internal error" (reproduced through the real binary,
2026-09-03). `bin.ts`, the scheduler and `@vzn/vx-mcp` consult this
helper; it is on the façade so a plugin can classify the same way. The
**name** `UserError` is the contract that survives the copy boundary: a
plugin may throw its own class named `UserError` without importing core's.

`isExecutableMissing(err)` is Bun's `ENOENT` for a spawn that could not
run at all, and `gitSpawnRefusal(cwd)` the one `UserError` for a git that
is not on PATH — the input enumeration and `--affected` say it (item 241): install git, not "git init".

`configErrorFrame(message, cwd)` (`src/util/config-frame.ts`) is how
`bin.ts` prints a config refusal: from the message the schema writes
(`<file>: tasks.<name>.<path> …`, or `<file> has unknown field …`) it
finds the field's key in the file, path segment after path segment, and
returns the message with the file at `line:col` (relative to `cwd`
unless that climbs out) and the lines up to it with a caret; undefined
when it cannot place the field, and the message prints as it was.
