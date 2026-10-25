// PROTOCOL.md § What the relay knows: a relay stores nothing (owner,
// 2026-10-25: "never even store on relay. That protocol contract").
// Every relay this package ships is held to it: the source of each
// (Bun, Workers, and the Docker image, which runs the Bun one) names no
// storage API, and a Durable Object that reaches for its storage fails.

import { expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { RelayRun, type DurableObjectState, type Env } from '../src/worker.js'
import type { Kept } from '../src/relay.js'

const root = path.join(import.meta.dir, '..')
const src = path.join(root, 'src')

/** What would let a relay write: a file, a database, Workers storage, an alarm. */
const STORAGE = [
  /from 'bun:sqlite'/,
  /from '(node:)?fs(\/promises)?'/,
  /\bBun\.(write|file)\b/,
  /\.storage\b/,
  /\bsetAlarm\b/,
  /\blocalStorage\b|\bindexedDB\b/,
]

it('names no storage API in any relay’s source', () => {
  const hits = readdirSync(src)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) =>
      readFileSync(path.join(src, f), 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          STORAGE.some((re) => re.test(line)) ? [`src/${f}:${i + 1}: ${line.trim()}`] : [],
        ),
    )
  expect(hits).toEqual([])
})

it('gives the Docker image no volume to write', () => {
  expect(readFileSync(path.join(root, 'Dockerfile'), 'utf8')).not.toMatch(/^\s*VOLUME\b/m)
})

it('runs a Workers session through hibernation without touching its storage', () => {
  Object.assign(globalThis, {
    caches: { default: { match: async () => undefined, put: async () => {} } },
  })
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
  // Only its sockets: any other part of the object's state is storage.
  const state = new Proxy(
    { acceptWebSocket: () => {}, getWebSockets: () => [o, a] },
    {
      get(t, p) {
        if (p in t) return t[p as keyof typeof t]
        throw new Error(`the relay stores nothing, but read state.${String(p)}`)
      },
    },
  ) as DurableObjectState
  const env: Env = {
    RELAY: { idFromName: () => ({}), get: () => ({ fetch: async () => new Response() }) },
    ALLOW: 'https://issuer.example:o/r:.gitlab-ci.yml',
  }
  const run = new RelayRun(state, env)
  run.webSocketMessage(a, JSON.stringify({ n: 1, sends: [{ to: 'host', body: 'hi' }] }))
  run.webSocketMessage(o, JSON.stringify({ n: 2, sends: [{ to: 'a', body: 'go' }] }))
  run.webSocketClose(a)
  run.webSocketMessage(o, JSON.stringify({ n: 3, leave: true }))
  run.webSocketClose(o)
  expect(pushed.get('a')).toContainEqual({ messages: [{ from: 'host', body: 'go' }] })
})
