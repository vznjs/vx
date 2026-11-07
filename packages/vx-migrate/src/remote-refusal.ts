/** How long the body's first chunk is waited for: a refusal is not held on a body that never comes. */
const BODY_WAIT_MS = 1_000

/**
 * The most of the first chunk read: a token that starts within the line's
 * 200 characters must end within it to be hidden whole (a JWT is ~1 KB).
 */
const READ_BYTES = 4096

/** Shorter values are not hidden, as core masks none under 6 characters: each would blank common words. */
const MIN_TOKEN_CHARS = 6

/**
 * `text` with each of `tokens` written `***`: a server that quoted a
 * request's Authorization header printed the token to the CI log and
 * cache.db, as core masks only secret-named variables.
 */
export function hideTokens(text: string, tokens: Iterable<string | undefined>): string {
  let out = text
  for (const token of tokens)
    if (token !== undefined && token.length >= MIN_TOKEN_CHARS) out = out.replaceAll(token, '***')
  return out
}

/** `work`, each error it throws with `hide` applied: a thrown fetch error can quote a request's header. */
export async function hidingErrors<T>(
  work: Promise<T>,
  hide: (text: string) => string,
): Promise<T> {
  try {
    return await work
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const hidden = hide(message)
    if (hidden === message) throw err
    // The code is how core groups a failure (a reset connection), and a retry reads it.
    const code = (err as { code?: unknown } | null)?.code
    throw Object.assign(new Error(hidden), code === undefined ? {} : { code })
  }
}

/**
 * A remote's refusal, named by its status and its own words: "HTTP 500"
 * alone said nothing, and a batch query Vercel refused with 400 "Too many
 * hashes. Limit is 100." read as no answer and was never seen (main
 * f71b377, 2026-10-23). One line of the body, bounded: it is remote text,
 * each token `hide` knows written `***` before the cut, so none is left in
 * part. Shared by `turboCache()` and `nxCache()`.
 */
export async function refusal(
  res: Response,
  hide: (text: string) => string,
  what = '',
): Promise<Error> {
  let said = ''
  try {
    const reader = res.body?.getReader()
    if (reader !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const first = await Promise.race([
        reader.read(),
        new Promise<undefined>((r) => {
          timer = setTimeout(() => r(undefined), BODY_WAIT_MS)
        }),
      ]).finally(() => clearTimeout(timer))
      // quiet: read no further; a cancel that fails has nothing left to free
      void reader.cancel().catch(() => undefined)
      said = hide(new TextDecoder().decode(first?.value?.subarray(0, READ_BYTES)))
        .replace(/\s+/g, ' ')
        .trim()
    }
  } catch {
    // quiet: the status alone still names the refusal
  }
  // Each control as `\xNN`: an `ESC ]` in the server's words retitled the terminal (L-31).
  const line = said
    .slice(0, 200)
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  return new Error(`${what}HTTP ${res.status}${line === '' ? '' : `: ${line}`}`)
}
