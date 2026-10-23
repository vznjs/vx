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
      const { value } = await reader.read()
      await reader.cancel()
      said = new TextDecoder().decode(value?.subarray(0, 512)).replace(/\s+/g, ' ').trim()
    }
  } catch {
    // quiet: the status alone still names the refusal
  }
  return new Error(`${what}HTTP ${res.status}${said === '' ? '' : `: ${said.slice(0, 200)}`}`)
}
