// The Workers entry: every request of a run reaches that run's one
// Durable Object, and an object without ALLOW refuses to start.

import { afterEach, expect, it } from 'bun:test'
import worker, {
  RelayRun,
  type DurableObjectNamespace,
  type DurableObjectState,
  type Env,
} from '../src/worker.js'
import { sessionKey, type Kept } from '../src/relay.js'

/** Run ids: random UUIDs, as the relay takes. */
const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'
const C = '00000000-0000-4000-8000-000000000003'
const D = '00000000-0000-4000-8000-000000000004'
const E = '00000000-0000-4000-8000-000000000005'
const R = '00000000-0000-4000-8000-000000000006'

// Only the runtime has these: the tests make no websocket, and the cache holds nothing.
Object.assign(globalThis, {
  caches: { default: { match: async () => undefined, put: async () => {} } },
})

/** An object's state with no websocket. */
function state(): DurableObjectState {
  return {
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  }
}

/** Durable Objects by name, as the runtime keeps them. */
function namespace(env: () => Env): DurableObjectNamespace & { made: string[] } {
  const objects = new Map<string, RelayRun>()
  const made: string[] = []
  return {
    made,
    idFromName: (name) => name,
    get(id) {
      const name = id as string
      let o = objects.get(name)
      if (o === undefined) {
        o = new RelayRun(state(), env())
        objects.set(name, o)
        made.push(name)
      }
      return { fetch: (req) => o.fetch(req) }
    },
  }
}

const join = (env: Env, run: string, token?: string, origin = 'https://relay.example.com') =>
  worker.fetch(
    // No upgrade: Bun makes no 101, and each refusal here comes before one.
    new Request(
      `${origin}/v1/sessions/${run}/socket?join=${encodeURIComponent('{"role":"peer"}')}`,
      {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      },
    ),
    env,
  )

it('routes each run to its own object', async () => {
  issuer()
  let env: Env
  const ns = namespace(() => env)
  env = { RELAY: ns, ALLOW: `${ISS}:o/r:.gitlab-ci.yml`, AUDIENCE: 'vx-dte-server' }
  const token = await job(1)
  // 426, past the token: no websocket here to join on.
  expect([
    (await join(env, A, token)).status,
    (await join(env, A, token)).status,
    (await join(env, B, token)).status,
  ]).toEqual([426, 426, 426])
  const run = { iss: ISS, run: ['1'] }
  expect(ns.made).toEqual([await sessionKey(A, run), await sessionKey(B, run)])
  const res = await worker.fetch(new Request('https://relay.example.com/health'), env)
  expect([res.status, await res.json()]).toEqual([
    404,
    { error: 'no route GET /health: the relay serves GET /v1/sessions/<id>/socket (PROTOCOL.md)' },
  ])
})

// Each object a request wakes is billed, and a host's daily limit refuses
// every run past it: one with no good token woke one, so anyone could
// spend the relay's quota.
it('refuses a request without a good token at the door, waking no object', async () => {
  issuer()
  let env: Env
  const ns = namespace(() => env)
  env = { RELAY: ns, ALLOW: `${ISS}:o/r:.gitlab-ci.yml`, AUDIENCE: 'vx-dte-server' }
  const good = await job(1)
  const forged = `${good.slice(0, good.lastIndexOf('.'))}.${'A'.repeat(342)}`
  const refused = async (token?: string) => {
    const res = await join(env, A, token)
    return [res.status, ((await res.json()) as { error: string }).error]
  }
  expect([await refused(), await refused(forged)]).toEqual([
    [401, 'no bearer token'],
    [401, 'bad signature'],
  ])
  expect(ns.made).toEqual([])
})

it('gives the same run id of two repositories two objects', async () => {
  issuer()
  let env: Env
  const ns = namespace(() => env)
  env = { RELAY: ns, ALLOW: `${ISS}:o/r:.gitlab-ci.yml`, AUDIENCE: 'vx-dte-server' }
  await join(env, R, await job(1))
  await join(env, R, await job(2))
  await join(env, R, await job(1))
  const run = (project: string) => sessionKey(R, { iss: ISS, run: [project] })
  expect(ns.made).toEqual([await run('1'), await run('2')])
})

it('names why the host refused a run', async () => {
  const refused: Env = {
    RELAY: {
      idFromName: (name) => name,
      get: () => ({
        fetch: () =>
          Promise.reject(new Error('Exceeded allowed duration in Durable Objects free tier.')),
      }),
    },
    ALLOW: `${ISS}:o/r:.gitlab-ci.yml`,
    AUDIENCE: 'vx-dte-server',
  }
  issuer()
  const res = await join(refused, A, await job(1))
  expect([res.status, await res.json()]).toEqual([
    503,
    {
      error:
        "the relay's host refused the run: Exceeded allowed duration in Durable Objects free tier.",
    },
  ])
})

// A run under an empty ALLOW got 503s, which a client waits out (2026-10-23).
it('refuses every join with a 403 while ALLOW admits no one, waking no object', async () => {
  for (const [allow, error] of [
    [' ', "this relay's ALLOW is empty: it admits no run"],
    ['o/r', "this relay's ALLOW: o/r is not issuer:owner/repo:workflow"],
    // wrangler.jsonc may write a var as a JSON list: "list.split is not a
    // function", where the cache and history Workers name ALLOW's form.
    [
      ['https://gitlab.com:o/r:.gitlab-ci.yml'],
      "this relay's ALLOW: one string of issuer:owner/repo:workflow entries, space separated",
    ],
  ] as const) {
    const env: Env = {
      RELAY: {
        idFromName: (n) => n,
        get: () => ({ fetch: () => Promise.reject(new Error('woken')) }),
      },
      ALLOW: allow as string,
    }
    const res = await join(env, A)
    expect([res.status, await res.json()]).toEqual([403, { error }])
  }
})

// jose matches aud exactly: AUDIENCE with a pasted newline refused every
// token as the wrong audience, and a blank one was the audience itself.
// The relay on Bun, and the cache and history servers' Workers, trim it
// and refuse a blank one.
it('reads AUDIENCE without the blanks around it, and refuses a blank one', async () => {
  issuer()
  let env: Env
  env = {
    RELAY: namespace(() => env),
    ALLOW: `${ISS}:o/r:.gitlab-ci.yml`,
    AUDIENCE: ' vx-dte-server\n',
  }
  // 426, past the token: no websocket here to join on.
  expect((await join(env, A, await job(1))).status).toBe(426)
  const blank: Env = {
    RELAY: {
      idFromName: (n) => n,
      get: () => ({ fetch: () => Promise.reject(new Error('woken')) }),
    },
    ALLOW: `${ISS}:o/r:.gitlab-ci.yml`,
    AUDIENCE: ' ',
  }
  const res = await join(blank, B, await job(1))
  expect([res.status, await res.json()]).toEqual([
    403,
    { error: "this relay's AUDIENCE: the aud CI tokens name, or unset, not blank" },
  ])
  // wrangler.jsonc may write a var as JSON: "env.AUDIENCE.trim is not a
  // function" escaped the Worker as a 500.
  for (const audience of [42, ['vx-dte-server']]) {
    const listed = await join({ ...blank, AUDIENCE: audience as never }, C, await job(1))
    expect([listed.status, await listed.json()]).toEqual([
      403,
      { error: "this relay's AUDIENCE: one string, the aud CI tokens name" },
    ])
  }
})

// No object bound: each join threw "Cannot read properties of
// undefined", a 500 a client retries until its deadline.
it('refuses every join with a 403, saying why, while RELAY is unbound', async () => {
  const res = await join({ ALLOW: 'https://gitlab.com:o/r:.gitlab-ci.yml' } as Env, A)
  expect([res.status, await res.json()]).toEqual([
    403,
    { error: 'RELAY: bind the RelayRun Durable Object as RELAY (wrangler.jsonc durable_objects)' },
  ])
})

// Hibernated, an object is built again from its sockets: it writes no storage.
it('rebuilds a run from its sockets’ attachments when it wakes', () => {
  const pushed = new Map<string, unknown[]>()
  const sock = (kept: Kept) => {
    pushed.set(kept.id, [])
    return {
      send: (t: string) => void pushed.get(kept.id)!.push(JSON.parse(t)),
      accept() {},
      close() {},
      serializeAttachment() {},
      deserializeAttachment: () => kept,
    }
  }
  const o = sock({ key: 'k', id: 'o', role: 'host', cert: 'c' })
  const a = sock({ key: 'k', id: 'a', role: 'peer' })
  const env: Env = { RELAY: namespace(() => env), ALLOW: `${ISS}:o/r:.gitlab-ci.yml` }
  const run = new RelayRun({ acceptWebSocket: () => {}, getWebSockets: () => [o, a] }, env)
  run.webSocketMessage(a, JSON.stringify({ sends: [{ to: 'host', body: 'hi' }] }))
  run.webSocketMessage(o, JSON.stringify({ sends: [{ to: 'a', body: 'go' }] }))
  expect([pushed.get('o'), pushed.get('a')]).toEqual([
    [{ messages: [{ from: 'a', body: 'hi' }] }],
    [{ messages: [{ from: 'host', body: 'go' }] }],
  ])
})

// A socket `attach` closed (gone, or refused) keeps no attachment: its
// close threw in the object (main 8d0619f's redial, 2026-10-24).
it('closes a socket that kept nothing as gone, and ignores its frames and close', () => {
  const env: Env = { RELAY: namespace(() => env), ALLOW: `${ISS}:o/r:.gitlab-ci.yml` }
  const closed: (number | undefined)[] = []
  const gone = {
    send() {},
    accept() {},
    close: (code?: number) => void closed.push(code),
    serializeAttachment() {},
    deserializeAttachment: () => null,
  }
  // Woken with it among its sockets, as after hibernation.
  const run = new RelayRun({ acceptWebSocket: () => {}, getWebSockets: () => [gone] }, env)
  expect(closed).toEqual([4404])
  run.webSocketMessage(gone, '{"n":1,"leave":true}')
  run.webSocketClose(gone)
  run.webSocketError(gone)
})

it('will not start without ALLOW, or with an entry it cannot read', () => {
  const none: Env = { RELAY: namespace(() => none), ALLOW: ' ' }
  expect(() => new RelayRun(state(), none)).toThrow('vx-dte-server: set ALLOW')
  const bad: Env = { RELAY: namespace(() => bad), ALLOW: 'o/r' }
  expect(() => new RelayRun(state(), bad)).toThrow(
    'vx-dte-server: ALLOW: o/r is not issuer:owner/repo:workflow',
  )
})

const ISS = 'https://issuer.example'
const pair = (await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
async function sign(claims: Record<string, unknown>): Promise<string> {
  const head = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(claims)}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, Buffer.from(head))
  return `${head}.${Buffer.from(sig).toString('base64url')}`
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** ISS serves its keys. */
function issuer(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === `${ISS}/.well-known/openid-configuration`) {
      return Response.json({ jwks_uri: `${ISS}/jwks` })
    }
    if (url === `${ISS}/jwks`) return Response.json({ keys: [{ ...jwk, kid: 'k1' }] })
    return new Response(null, { status: 404 })
  }) as typeof fetch
}

/** A token of a job of o/r's `.gitlab-ci.yml`, in GitLab project `project`. */
const job = (project: number, aud = 'vx-dte-server') =>
  sign({
    iss: ISS,
    aud,
    exp: Date.now() / 1000 + 300,
    project_id: project,
    project_path: 'o/r',
    ci_config_ref_uri: 'issuer.example/o/r//.gitlab-ci.yml@refs/heads/main',
  })

it('takes its own URL as the audience when AUDIENCE is not set', async () => {
  issuer()
  let env: Env
  env = { RELAY: namespace(() => env), ALLOW: `${ISS}:o/r:.gitlab-ci.yml` }
  const token = (aud: string) => job(1, aud)
  const mine = await join(env, C, await token('https://relay.example.com'))
  const other = await join(env, D, await token('https://other.example.com'))
  const elsewhere = await join(
    env,
    E,
    await token('https://other.example.com'),
    'https://other.example.com',
  )
  // 426, past the token: no websocket here to join on.
  expect([mine.status, other.status, await other.json(), elsewhere.status]).toEqual([
    426,
    401,
    {
      error:
        "the token's aud is https://other.example.com, not this relay's https://relay.example.com: ask CI for a token for https://relay.example.com, or set the relay's audience",
    },
    426,
  ])
})
