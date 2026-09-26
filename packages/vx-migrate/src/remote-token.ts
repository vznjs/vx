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
