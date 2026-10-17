import { isSecretUnavailable, type RemoteOpenContext } from '@vzn/vx'

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

/** One remote's keychain entry: `key` names it, `label` and `env` are what a person reads. */
export interface KeychainRemote {
  readonly key: string
  readonly label: string
  /** The variable that sets the token instead, named in the warning. */
  readonly env: string
}

/**
 * The token from the plugin's OS keychain, asked for on a terminal when
 * missing (core's `ctx.secret`): the last source, after the option, the
 * variable and the config files. A throw is the one warning that leaves the
 * run on the local cache.
 */
export async function keychainToken(
  ctx: RemoteOpenContext,
  remote: KeychainRemote,
): Promise<string> {
  let token: string
  try {
    token = await ctx.secret({
      key: remote.key,
      prompt: `Token for ${remote.label}, saved to the OS keychain: `,
    })
  } catch (err) {
    if (!isSecretUnavailable(err)) throw err
    throw new Error(
      `no token for ${remote.label}: set ${remote.env}, run vx in a terminal to be asked for one (kept in the OS keychain), or pass --cache-policy=remote: to skip the remote; local cache only this run`,
    )
  }
  const fault = headerValueFault(token)
  if (fault !== null) {
    await ctx.forgetSecret({ key: remote.key })
    throw new Error(
      `the OS keychain's token for ${remote.label} holds ${fault}, which no HTTP header can carry (it is not printed); removed it, so the next run asks again`,
    )
  }
  return token.trim()
}

/** How a remote reads in a prompt or a warning: its host, then its team. */
export function remoteLabel(url: string, team: string | undefined): string {
  const host = URL.canParse(url) ? new URL(url).host : url
  return team === undefined ? host : `${host} (${team})`
}
