# `src/util/secrets.ts` — a plugin's keychain

## Purpose

A remote cache's token typed into every shell (`export TURBO_TOKEN=…`) is
friction a laptop should not have. `ctx.secret` keeps a plugin's secrets
in the OS keychain (`Bun.secrets`: macOS Keychain, libsecret, Windows
Credential Manager) and, when the plugin offers a prompt, asks once on the
terminal and saves the answer (2026-10-17). Core reads no
environment here: a variable, an option or a config file is the plugin's
to check first, so the keychain is always the last source.
`src/util/hidden-prompt.ts` is the terminal side.

## Public surface

```ts
export interface SecretRequest {
  readonly key: string
  readonly prompt?: string
}
export interface PluginSecrets {
  secret(req: SecretRequest): Promise<string>
  forgetSecret(req: { readonly key: string }): Promise<void>
}
export type SecretUnavailableReason = 'not-found' | 'no-terminal' | 'declined' | 'store-unavailable'
export interface SecretUnavailable extends Error {
  readonly reason: SecretUnavailableReason
}
export function isSecretUnavailable(err: unknown): err is SecretUnavailable
export interface SecretStore {
  get(o: { service: string; name: string }): Promise<string | null>
  set(o: { service: string; name: string; value: string }): Promise<void>
  delete(o: { service: string; name: string }): Promise<boolean>
}
export class SecretBroker {
  constructor(
    ci: boolean,
    warn: (m: string) => void,
    store?: SecretStore,
    terminal?: SecretTerminal,
    quiet?: () => () => void, // erases the live region until the release; run.ts: the terminal logger's holdStatus
  )
  for(plugin: string): PluginSecrets
  closePrompts(): void
}
export interface SecretTerminal {
  interactive(): boolean
  ask(question: string): Promise<string>
}
export function terminalOf(stdin, stderr, interrupt?): SecretTerminal
```

- **Where.** On `setup`'s context and on a remote layer's `open`
  (`RemoteOpenContext`): the hooks that run before the status line. A
  `SecretBroker` per run (`run.ts`); `closePrompts` right before
  `runStart`, so a later ask is `no-terminal`, never drawn over the frames.
  An earlier step (`vx:load`) has already started the region's ticker, so
  `quiet` holds every draw from the question to its answer: the ticker's
  erase wiped the prompt line, and vx looked frozen (2026-10-17).
- **Order.** The keychain entry (service: the plugin's package name, name:
  `key`), else, given a `prompt`, the terminal's answer, trimmed and saved.
  Else a rejection `isSecretUnavailable` names: `not-found` (no prompt),
  `no-terminal` (CI, stdin or stderr not a TTY, a terminal that refuses
  raw mode, or prompts closed),
  `declined` (an empty answer, Ctrl-D, Ctrl-C), `store-unavailable` (the
  keychain threw and no prompt was given). By name, not `instanceof`: a
  plugin may load its own copy of core.
- **Once per run per plugin and key.** Concurrent asks share one promise;
  a rejection is kept too, so nothing is asked twice. `forgetSecret` drops
  the memo and deletes the entry (a server refused it); it never throws.
- **One prompt at a time.** A prompt waits for the one before it, so two
  plugins never interleave on the terminal.
- **No keychain** (headless Linux without libsecret): a read is a miss; an
  answer that cannot be saved is used for the run, with one warning.
- **Hidden input.** Raw mode, nothing echoed, backspace edits, the mode
  restored after. Raw mode swallows SIGINT, so Ctrl-C answers nothing and
  raises it: the run stops as it would at any other moment.

## Tests

`tests/secrets.test.ts` (order, no environment, namespacing, memo,
forget, the three prompt gates and the closed-prompt gate, serialization,
store-unavailable, the hidden input); `tests/remote-open.test.ts` (the
run hands `open` its secrets).
