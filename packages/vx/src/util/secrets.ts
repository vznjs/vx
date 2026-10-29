// A plugin's secrets, kept in the OS keychain (`Bun.secrets`) under the
// plugin's own name, and asked for on the terminal when a plugin offers a
// prompt and someone can answer (2026-10-17). Core reads no
// environment here: a variable, an option or a config file is the
// plugin's to check first, so the keychain is always the last source.

import { type SecretTerminal, terminalOf } from './hidden-prompt.js'
import { holdSecret } from './secret-mask.js'

/** What `ctx.secret` is asked: the entry's name, and the question to ask on a terminal. */
export interface SecretRequest {
  /** The entry's name within the plugin's keychain service: one per remote, say. */
  readonly key: string
  /** Asked when the keychain lacks the entry. Omitted: never asked, a miss is `not-found`. */
  readonly prompt?: string
}

/** A plugin's keychain, on the contexts of the hooks that run before the first task. */
export interface PluginSecrets {
  /**
   * The entry, else the terminal's answer (then saved), else a rejection a
   * `isSecretUnavailable` guard names. Once per run per key: concurrent asks
   * share the answer.
   */
  secret(req: SecretRequest): Promise<string>
  /** Delete the entry (a server refused it), so the next run asks again. Never throws. */
  forgetSecret(req: { readonly key: string }): Promise<void>
}

/**
 * Why `secret` had nothing: the keychain lacks it and no prompt was given
 * (`not-found`), a prompt was given and nobody can answer — CI, no TTY, or
 * the status line already up (`no-terminal`), the answer was empty
 * (`declined`), or there is no keychain and no answer (`store-unavailable`).
 */
export type SecretUnavailableReason = 'not-found' | 'no-terminal' | 'declined' | 'store-unavailable'

export interface SecretUnavailable extends Error {
  readonly reason: SecretUnavailableReason
}

const NAME = 'SecretUnavailable'

/** A `secret` rejection that is a missing secret, not a fault. By name: a plugin may load its own copy of core. */
export function isSecretUnavailable(err: unknown): err is SecretUnavailable {
  return err instanceof Error && err.name === NAME && 'reason' in err
}

function unavailable(key: string, reason: SecretUnavailableReason): SecretUnavailable {
  return Object.assign(new Error(`secret '${key}' unavailable: ${reason}`), { name: NAME, reason })
}

/** The keychain as the broker reads and writes it: `Bun.secrets`, or a test's stand-in. */
export interface SecretStore {
  get(o: { service: string; name: string }): Promise<string | null>
  set(o: { service: string; name: string; value: string }): Promise<void>
  delete(o: { service: string; name: string }): Promise<boolean>
}

// Reached only when asked: touching `process.stdin` opens the stream.
const processTerminal: SecretTerminal = {
  interactive: () => terminalOf(process.stdin, process.stderr).interactive(),
  ask: (question) => terminalOf(process.stdin, process.stderr).ask(question),
}

/**
 * One run's secrets for every plugin. A prompt waits for the one before
 * it, so two plugins never ask at once, and none is asked once
 * `closePrompts` says the status line is up.
 */
export class SecretBroker {
  private readonly memo = new Map<string, Promise<string>>()
  private prompting: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private readonly ci: boolean,
    private readonly warn: (message: string) => void,
    private readonly store: SecretStore = Bun.secrets,
    private readonly terminal: SecretTerminal = processTerminal,
    /** Quiets the terminal's live region until the release it returns. */
    private readonly quiet: () => () => void = () => () => undefined,
  ) {}

  /** `plugin`'s keychain: its entries live under its package name. */
  for(plugin: string): PluginSecrets {
    return {
      secret: (req) => {
        const memoKey = `${plugin}\0${req.key}`
        let pending = this.memo.get(memoKey)
        if (pending === undefined) {
          pending = this.resolve(plugin, req)
          this.memo.set(memoKey, pending)
        }
        return pending
      },
      forgetSecret: async ({ key }) => {
        this.memo.delete(`${plugin}\0${key}`)
        try {
          await this.store.delete({ service: plugin, name: key })
        } catch {
          // no keychain to delete from
        }
      },
    }
  }

  /** The status line is about to start: from here a prompt would be drawn over. */
  closePrompts(): void {
    this.closed = true
  }

  private async resolve(service: string, req: SecretRequest): Promise<string> {
    const entry = { service, name: req.key }
    let storeDown = false
    try {
      const stored = await this.store.get(entry)
      if (stored) {
        holdSecret(stored)
        return stored
      }
    } catch {
      // No keychain (headless Linux without libsecret).
      storeDown = true
    }
    if (req.prompt === undefined)
      throw unavailable(req.key, storeDown ? 'store-unavailable' : 'not-found')
    const asked = this.prompting.then(() => this.ask(req.key, req.prompt!))
    this.prompting = asked.catch(() => undefined)
    const answer = await asked
    holdSecret(answer)
    try {
      await this.store.set({ ...entry, value: answer })
    } catch (err) {
      this.warn(
        `[vx] could not save '${req.key}' to the OS keychain (${err instanceof Error ? err.message : String(err)}); used for this run only`,
      )
    }
    return answer
  }

  private async ask(key: string, prompt: string): Promise<string> {
    if (this.ci || this.closed || !this.terminal.interactive())
      throw unavailable(key, 'no-terminal')
    const release = this.quiet()
    let answer: string
    try {
      answer = (await this.terminal.ask(prompt)).trim()
    } finally {
      release()
    }
    if (answer === '') throw unavailable(key, 'declined')
    return answer
  }
}
