/** How long the body's first chunk is waited for: a refusal is not held on a body that never comes. */
const BODY_WAIT_MS = 1_000

/**
 * A remote's refusal, named by its status and its own words: "HTTP 500"
 * alone said nothing, and a batch query Vercel refused with 400 "Too many
 * hashes. Limit is 100." read as no answer and was never seen (main
 * f71b377, 2026-10-23). One line of the body, bounded: it is remote text.
 * Shared by `turboCache()` and `nxCache()`.
 */
export async function refusal(res: Response, what = ''): Promise<Error> {
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
      said = new TextDecoder().decode(first?.value?.subarray(0, 512)).replace(/\s+/g, ' ').trim()
    }
  } catch {
    // quiet: the status alone still names the refusal
  }
  return new Error(`${what}HTTP ${res.status}${said === '' ? '' : `: ${said.slice(0, 200)}`}`)
}
