# `src/util/secret-mask.ts` — masking secret-named values in what vx shows

## Purpose

A task that echoes `$NPM_TOKEN`, or a TS config that builds its command
from `process.env.API_KEY`, put the value in the terminal, the stdout
the cache keeps and every hit replays, the `$ command` line, telemetry
records and `vx show` (L-11). The mask replaces a known value wherever it
appears, the way GitHub Actions masks its secrets.

```ts
export const MASKED = '***'
export interface SecretMask {
  mask(text: string): string
  stream(): { push(chunk: string): string; end(): string }
  maskCut(head: string, tail: string): [string, string] // also the pieces a cut left
}
export function secretMask(
  sources: readonly (Record<string, string | undefined> | undefined)[],
  named?: readonly string[], // the task's `exec.env.secret`: masked whatever the name
): SecretMask | null
export interface TaskEnvSecrets {
  readonly define?: Record<string, string>
  readonly secret?: readonly string[]
}
export function maskedCommand(command: string, env?: TaskEnvSecrets): string
export function maskedLine(line: string): string // this process's secrets only
export function secretNamed(name: string): boolean // the name rule alone; `vx why` hides such an env input's hashes
export function maskedEmitter(
  mask: SecretMask,
  emit: (text: string) => void,
  idleMs?: number,
): { push(chunk: string): void; end(): void }
```

A variable is masked when its name holds `TOKEN`, `SECRET`, `KEY`,
`PASSWORD`, `PASSWD` or `CREDENTIAL`, it does not end `_FILE`, `_PATH`
or `_DIR` and is not git's `GIT_CONFIG_KEY_<n>`, or the task names it in
`exec.env.secret` (L-14), and its value has six characters or more. No such variable: `secretMask` is null and nothing is
paid per byte.

`stream()` holds back only a tail that could begin a value, so a value
split across two chunks is caught and output that cannot be one (a
`readyWhen` line, a start marker) is never delayed. `maskedEmitter` emits a held tail
25 ms after the last chunk when none follows, so a long task's last
characters do not wait for its exit; a value split by a longer pause
between two writes is not caught. `maskCut` masks the two sides of a
cut whose middle is gone: a value the cut split leaves a piece at the
end of `head` or the start of `tail`, and each piece is masked too.

Callers: `orchestrator/execute-task.ts` (live output, captured stdout),
`orchestrator/hit-restore.ts` (a replayed hit's stdout),
`orchestrator/framed-output.ts`, `orchestrator/events.ts` and
`orchestrator/telemetry.ts` (the command; `events.ts` also masks every
status line, where plugin warnings land, L-40), `orchestrator/remote-prefetch.ts`
(the command a remote hit's entry row stores), `cli/show.ts`, `cli/plugin-commands.ts` and `cli/select.ts` (a
plugin's warning, `maskedLine`); `maskedCommand`
is on `@vzn/vx` for `@vzn/vx-mcp`'s `listTasks` (L-26).
