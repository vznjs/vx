# `src/settings.ts` — every vx setting, once

## Purpose

The one list of run-wide settings. A setting's path is its
`vx.workspace` key (`run.concurrency`); its variable
(`VX_RUN_CONCURRENCY`) and flag (`--concurrency`) derive from that path. The CLI parsers, the
workspace validator, `vx info`'s `settings` fact and the settings tables
in `schema.md` and `cli.md` all read it, so a setting cannot exist in
one and be missing in another (`tests/settings.test.ts`).

## Public surface

```ts
export const SETTINGS: readonly Setting[]
export const SETTING_GROUPS: readonly ['run', 'cache', 'watch']
export const RENAMED: ReadonlyMap<string, Setting>
export function setting(path: string): Setting
export function kindHint(kind: SettingKind): string
export function renamedRefusal(old: string, s: Setting, value?: string): string
export function atPath(config: unknown, path: string): unknown
export function runRules(workspace: unknown): { exclusiveOutputs?: boolean; upfrontKeys?: boolean }
export function envName(path: string): string
export function parseSettingValue(kind: SettingKind, raw: unknown): unknown
export function settingRefusal(path: string, where: string, raw: unknown, got?: string): string
export function settingEnv(path: string, env?: NodeJS.ProcessEnv): unknown
export function checkSettingsEnv(env?: NodeJS.ProcessEnv): void
export function resolveSetting(
  path: string,
  workspace: unknown,
  flag?: unknown,
  env?: NodeJS.ProcessEnv,
): { value: unknown; source: SettingSource }
```

## Rules

- Precedence: flag, then variable, then `vx.workspace`, then the
  default. A task's `exec.timeout` / `exec.retries` beats all of them.
- A renamed variable or flag (`was`) is refused naming its new name;
  there are no aliases.
- A setting with `config: false` is read before `vx.workspace` loads,
  so it has a variable and maybe a flag, no key.
- The CLI checks every set variable up front (`checkSettingsEnv`), so a
  deep reader may fall back on a bad value instead of throwing.

`src/orchestrator/run-settings.ts` fills a run's options from this
list once, before any task (`withRunSettings`).
