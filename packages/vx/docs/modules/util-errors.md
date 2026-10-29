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
  parts?: RefusalParts // the terminal form, when a verb renders it as a notice
  constructor(message: string, code?: string)
}
export interface RefusalParts {
  readonly tone?: 'info' // nothing is wrong, just nothing to show yet; default error
  readonly headline: string
  readonly what?: readonly string[]
  readonly why?: string
  readonly fix?: string
}
export function refusal(parts: RefusalParts, opts?: { code?; message? }): UserError // message defaults to the parts joined
export function isUserError(err: unknown): err is UserError // by name, across a copy boundary (below)
export function errorCode(err: unknown): string // the stable code of anything bin.ts catches
export function thrownMessage(err: unknown): string // what any thrown value says; never throws
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
export function gitFailure(cwd: string, args: string, exitCode: number, stderr: string): UserError // a git that failed in cwd: notAWorkTree, else VX_E_GIT

// src/util/config-frame.ts: a config refusal at its `line:col`, with the source under it; undefined when it names no field
export function configErrorFrame(message: string, cwd: string): string | undefined
export function configRefusal(message: string, cwd: string): ConfigRefusal | undefined // { where, problem, allowed?, fix?, frame }: the same, in a notice's parts

// src/util/refusal-notice.ts: every refusal and warning a verb prints, as one ui.notice
export function messageParts(message: string): RefusalParts // first sentence heads; later sentences and indented lines are facts; "(see `cmd`)" is why, "did you mean X?" the fix
export function refusalNotice(
  verb: string,
  message: string,
  parts?: RefusalParts,
  opts?: { headline?; cwd? },
): Block // parts, else a config refusal's frame, else messageParts
export function lineNotice(tone: Tone, line: string, verb?: string): Block // the verb read off a `vx X:` prefix
export function sayNotice(tone: Tone, verb: string, message: string): void // a message as a notice, on stderr
export function sayLine(tone: Tone, line: string, verb?: string): void // lineNotice, on stderr
```

`UserError` instances have `.name === 'UserError'`. `bin.ts` prints
anything `isUserError` admits as `refusalNotice(verb, err.message, err.parts)`,
the verb read off the message's `vx X:` prefix or argv; a file-system refusal
(`isFsRefusal`) as its message plus `fsRefusalHint`; a process out of
file descriptors (`isOutOfFds`) as its message plus `OUT_OF_FDS_HINT`;
anything else with
its stack. Every one sets exit code 1 — nothing is re-thrown. When the
argv asks for JSON (`wantsJson`), `bin.ts` also prints `errorDocument`
on stdout with `errorCode`: a UserError's own code (`VX_E_CONFIG` for a
codeless one that opens with its config file, which a config's own
throw becomes: `<kind> config <file> threw: …`), `VX_E_FDS`, `VX_E_FS`, or `VX_E_INTERNAL`. The codes are listed in `cli.md` § Error codes.
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
`tests/refusal-notice.test.ts` — how a message splits into a notice's parts.
Real coverage comes from every module's "bad input" tests.

## `isUserError(err)`

`instanceof UserError`, plus the same class arriving from **another copy of
core**. A compiled `vx` binary carries core inside it while a workspace
plugin imports `@vzn/vx` from `node_modules`, so a plugin's `UserError` is a
different class object and `instanceof` is false across the boundary — a
plugin verb's refusal printed with a stack, and a REAPI refusal would have
read as an "internal error" (reproduced through the real binary,
2026-09-03). `bin.ts`, the scheduler and the plugins consult this
helper; it is on the façade so a plugin can classify the same way. The
**name** `UserError` is the contract that survives the copy boundary: a
plugin may throw its own class named `UserError` without importing core's.

`thrownMessage(err)` is what a line naming a plugin's failure quotes. A
plugin may throw anything: `String(err)` read `[object Object]` for an
error-like `{ message }`, `undefined` for a bare `throw`, and threw itself
on an object with no prototype. It takes a string `message` when there is
one, else says `threw <value>` (`tests/plugin-thrown-values.test.ts`).

`isExecutableMissing(err)` is Bun's `ENOENT` for a spawn that could not
run at all, and `gitSpawnRefusal(cwd)` the one `UserError` for a git that
is not on PATH — the input enumeration and `--affected` say it (item 241): install git, not "git init".

`configErrorFrame(message, cwd)` (`src/util/config-frame.ts`) is how
`bin.ts` and `vx lock` print a config refusal: from the message the schema writes
(`<file>: tasks.<name>.<path> …`, or `<file> has unknown field …`) it
finds the field's key in the file, path segment after path segment, and
returns the message with the file at `line:col` (relative to `cwd`
unless that climbs out) and the lines up to it with a caret; undefined
when it cannot place the field, and the message prints as it was. The
loader's syntax error (`Project config <file>:<line>:<col>: …`, Bun's
position) is framed at that position.
