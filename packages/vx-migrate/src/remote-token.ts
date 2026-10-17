import { terminalOf, type TokenTerminal } from './terminal-prompt.js'

/**
 * Why a string cannot be an HTTP header value, or null when it can. Bun's
 * `fetch` refuses a value holding a line break or NUL, or a character past
 * Latin-1, once it has trimmed the ends (measured on 1.4.2), and its error
 * QUOTES the whole value: a token with an interior newline (a two-line
 * secret file) reached every degrade warning as `'Bearer <token>'` (item
 * 927). A caller refuses with this reason and never with the value. Shared
 * by `turboCache()` and `nxCache()`.
 */
export function headerValueFault(value: string): string | null {
  let past = false
  for (const ch of value.trim()) {
    const c = ch.codePointAt(0)!
    if (c === 0x0a || c === 0x0d || c === 0) return 'a line break or NUL'
    if (c > 0xff) past = true
  }
  return past ? 'a character past Latin-1' : null
}

/** The OS keychain as a token source reads and writes it: `Bun.secrets`, or a test's stand-in. */
export interface SecretStore {
  get(o: { service: string; name: string }): Promise<string | null>
  set(o: { service: string; name: string; value: string }): Promise<void>
  delete(o: { service: string; name: string }): Promise<boolean>
}

/** One remote's keychain entry: `name` keys it, `label` and `env` are what a person reads. */
export interface KeychainRemote {
  readonly name: string
  readonly label: string
  /** The variable that sets the token instead, named in the warning. */
  readonly env: string
}

/** Every remote's entry lives under this keychain service. */
const KEYCHAIN_SERVICE = 'vx-migrate'

// Reached only when asked: touching `process.stdin` opens the stream.
const processTerminal: TokenTerminal = {
  interactive: () => terminalOf(process.stdin, process.stderr).interactive(),
  ask: (question) => terminalOf(process.stdin, process.stderr).ask(question),
}

/**
 * The tokens a cache plugin reads from the OS keychain when neither its
 * option, its variable nor a config file gives one (owner, 2026-10-17).
 * Asked only from a layer's `open`, so a run that leaves the remote off,
 * and a plan, never touch the keychain. One answer per remote per process:
 * concurrent asks share it, and a watch cycle does not ask again.
 */
export class KeychainTokens {
  private readonly memo = new Map<string, Promise<string>>()
  constructor(
    private readonly store: SecretStore = Bun.secrets,
    private readonly terminal: TokenTerminal = processTerminal,
  ) {}

  /**
   * The keychain's token, else the terminal's answer (saved to the
   * keychain), else a throw: the warning that leaves the run on the local
   * cache. On CI, or with no terminal, nothing is asked.
   */
  token(remote: KeychainRemote, ci: boolean): Promise<string> {
    let pending = this.memo.get(remote.name)
    if (pending === undefined) {
      pending = this.resolve(remote, ci)
      this.memo.set(remote.name, pending)
    }
    return pending
  }

  /** The server refused the keychain's token: delete it, so the next run asks again. */
  async forget(remote: KeychainRemote): Promise<void> {
    this.memo.delete(remote.name)
    try {
      await this.store.delete({ service: KEYCHAIN_SERVICE, name: remote.name })
    } catch {
      // no keychain to delete from
    }
  }

  private async resolve(remote: KeychainRemote, ci: boolean): Promise<string> {
    const key = { service: KEYCHAIN_SERVICE, name: remote.name }
    let stored: string | null = null
    try {
      stored = await this.store.get(key)
    } catch {
      // No keychain (headless Linux without libsecret): as if empty.
    }
    if (stored) return checked(stored, remote)
    const missing = () =>
      new Error(
        `no token for ${remote.label}: set ${remote.env}, run vx in a terminal to be asked for one (kept in the OS keychain), or pass --cache-policy=remote: to skip the remote; local cache only this run`,
      )
    if (ci || !this.terminal.interactive()) throw missing()
    const answer = checked(
      await this.terminal
        .ask(`Token for ${remote.label}, saved to the OS keychain: `)
        .catch(() => ''),
      remote,
    )
    if (answer === '') throw missing()
    try {
      await this.store.set({ ...key, value: answer })
    } catch (err) {
      process.stderr.write(
        `[vx] could not save the token to the OS keychain (${err instanceof Error ? err.message : String(err)}); used for this run only\n`,
      )
    }
    return answer
  }
}

function checked(token: string, remote: KeychainRemote): string {
  const fault = headerValueFault(token)
  if (fault !== null)
    throw new Error(
      `the token for ${remote.label} holds ${fault}, which no HTTP header can carry (it is not printed)`,
    )
  return token.trim()
}

/** How a remote reads in a prompt or a warning: its host, then its team. */
export function remoteLabel(url: string, team: string | undefined): string {
  const host = URL.canParse(url) ? new URL(url).host : url
  return team === undefined ? host : `${host} (${team})`
}
