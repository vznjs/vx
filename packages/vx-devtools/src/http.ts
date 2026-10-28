// The answers and body reads vx's servers share (@vzn/vx-cache-server,
// @vzn/vx-history-server): each had its own copy of these.

import { Refusal } from './oidc.js'

const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  413: 'payload_too_large',
  500: 'internal_error',
  502: 'bad_gateway',
}

/** Every refusal: `{ code, message }` (Turbo's spec's `Error`), the message saying what to fix. */
export function errorJson(status: number, message: string): Response {
  return Response.json({ code: CODES[status] ?? 'error', message }, { status })
}

/** A route's wrong method: `405` with `Allow`. */
export function notAllowed(allow: string): Response {
  const res = errorJson(405, `this route takes ${allow}`)
  res.headers.set('allow', allow)
  return res
}

/** A JSON body of at most `max` bytes, else a `Refusal`. */
export async function readJson(req: Request, max: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
    throw new Refusal(400, 'the body is application/json')
  }
  if (Number(req.headers.get('content-length') ?? 0) > max) {
    throw new Refusal(413, `the body is at most ${max} bytes`)
  }
  const text = await textUpTo(req, max)
  try {
    return JSON.parse(text)
  } catch {
    throw new Refusal(400, 'the body is not JSON')
  }
}

/**
 * The body as text, refused past `max` bytes as they arrive: a chunked body
 * names no length, and was read whole before it was measured.
 */
async function textUpTo(req: Request, max: number): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  let seen = 0
  // Leaving the loop by a throw cancels the stream.
  for await (const chunk of req.body ?? []) {
    seen += chunk.byteLength
    if (seen > max) throw new Refusal(413, `the body is at most ${max} bytes`)
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}
