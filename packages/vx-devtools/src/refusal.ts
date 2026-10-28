// How vx's servers refuse a request: one body, `{ code, message }`, the
// shape of Turbo's spec's `Error`, so a client reads every server's
// refusal the same way and warns with its message.

/** A request refused: its HTTP status and what to fix. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

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

/** A refusal's answer: `{ code, message }`, the message saying what to fix. */
export function errorJson(status: number, message: string): Response {
  return Response.json({ code: CODES[status] ?? 'error', message }, { status })
}

/** A route's wrong method: `405`, naming the ones it takes in `Allow` and the message. */
export function notAllowed(allow: string): Response {
  const res = errorJson(405, `this route takes ${allow}`)
  res.headers.set('allow', allow)
  return res
}
