import { Hono } from 'hono'
import { bearerAuth } from './auth.js'
import type { Env, QueuedEvent, Variables } from './env.js'
import type { WireEvent } from './wire.js'

export { InflightDedupDO } from './inflight-dedup-do.js'
export { RunCoordinatorDO } from './run-coordinator-do.js'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.get('/', (c) =>
  c.html(`<!doctype html><meta charset="utf-8"><title>vx cloud</title>
<style>body{font:14px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#222}
code{background:#f4f4f4;padding:.1em .3em;border-radius:3px}
h1{margin-bottom:.2em}small{color:#666}</style>
<h1>vx cloud</h1>
<small>protocol ${c.env.VX_PROTOCOL_VERSION} · <a href="/version">/version</a> · <a href="/health">/health</a></small>
<p>Hosted observability, cache, and execution for <code>@vzn/vx</code>.
See <a href="https://github.com/vznjs/vx/tree/main/apps/cloud">apps/cloud README</a> to deploy.</p>`),
)

app.get('/health', (c) => c.json({ ok: true }))

app.get('/version', (c) =>
  c.json({
    protocol: c.env.VX_PROTOCOL_VERSION,
    vx: '0.0.0',
    channels: ['vx:events', 'vx:state', 'vx:rpc', 'vx:submit'],
    rpc: [
      'runTasks',
      'getRunState',
      'getCacheStats',
      'explainCacheKey',
      'whyDidThisRerun',
      'getRunHistory',
    ],
  }),
)

// --- Turbo-wire-compatible cache (Turbo's /v8/artifacts/ shape, verbatim).

const cache = new Hono<{ Bindings: Env; Variables: Variables }>()
cache.use('*', bearerAuth())

cache.put('/:hash', async (c) => {
  const hash = c.req.param('hash')
  const orgId = c.get('auth').orgId
  const body = await c.req.arrayBuffer()

  // TODO: validate HMAC tag via env.VX_REMOTE_CACHE_SIGNATURE_KEY when set
  // (mirror src/cache/remote-cache.ts — base64(HMAC-SHA256(key, hash + teamId + body))).

  await c.env.ARTIFACTS.put(artifactKey(orgId, hash), body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      duration: c.req.header('x-artifact-duration') ?? '0',
      tag: c.req.header('x-artifact-tag') ?? '',
    },
  })

  return c.json({ urls: [`/v8/artifacts/${hash}`] })
})

cache.get('/:hash', async (c) => {
  const hash = c.req.param('hash')
  const orgId = c.get('auth').orgId
  const obj = await c.env.ARTIFACTS.get(artifactKey(orgId, hash))
  if (!obj) return c.notFound()

  // TODO: verify HMAC tag on read when env.VX_REMOTE_CACHE_SIGNATURE_KEY is set;
  // a tampered artifact must surface as a hard error so the client falls back
  // to local execution.

  const headers = new Headers({ 'content-type': 'application/octet-stream' })
  const duration = obj.customMetadata?.['duration']
  const tag = obj.customMetadata?.['tag']
  if (duration) headers.set('x-artifact-duration', duration)
  if (tag) headers.set('x-artifact-tag', tag)
  return new Response(obj.body, { headers })
})

cache.on('HEAD', '/:hash', async (c) => {
  const hash = c.req.param('hash')
  const orgId = c.get('auth').orgId
  const obj = await c.env.ARTIFACTS.head(artifactKey(orgId, hash))
  return obj ? c.body(null, 200) : c.body(null, 404)
})

app.route('/v8/artifacts', cache)

// --- Insights ingest + read APIs.

const v1 = new Hono<{ Bindings: Env; Variables: Variables }>()
v1.use('*', bearerAuth())

v1.post('/events/ingest', async (c) => {
  const { events } = (await c.req.json()) as { events: WireEvent[] }
  const orgId = c.get('auth').orgId

  // Push to the queue; the consumer (queue() entry below) batches into D1.
  const messages: { body: QueuedEvent }[] = events.map((e) => ({
    body: {
      orgId,
      runId: e.traceId,
      seq: 0, // TODO: assign per-run monotonic seq in the consumer (D1 RETURNING)
      tsNs: e.timeUnixNano,
      eventJson: JSON.stringify(e),
    },
  }))
  await c.env.EVENT_INGEST.sendBatch(messages)
  return c.body(null, 202)
})

v1.get('/runs', async (c) => {
  const orgId = c.get('auth').orgId
  // TODO: support cursor/limit/repo/branch filters from query string.
  const rows = await c.env.DB.prepare(
    'SELECT run_id, repo, branch, commit_sha, started_at, ended_at, exit_code FROM runs WHERE org_id = ?1 ORDER BY started_at DESC LIMIT 100',
  )
    .bind(orgId)
    .all()
  return c.json({ runs: rows.results ?? [] })
})

v1.get('/runs/:runId', async (c) => {
  const orgId = c.get('auth').orgId
  const runId = c.req.param('runId')
  const run = await c.env.DB.prepare(
    'SELECT * FROM runs WHERE org_id = ?1 AND run_id = ?2 LIMIT 1',
  )
    .bind(orgId, runId)
    .first()
  if (!run) return c.json(null, 404)
  const tasks = await c.env.DB.prepare(
    'SELECT * FROM run_tasks WHERE run_id = ?1 ORDER BY span_start_ns',
  )
    .bind(runId)
    .all()
  return c.json({ run, tasks: tasks.results ?? [] })
})

v1.get('/runs/:runId/events', async (c) => {
  const orgId = c.get('auth').orgId
  const runId = c.req.param('runId')

  // Confirm the run belongs to this org before streaming.
  const owns = await c.env.DB.prepare(
    'SELECT 1 FROM runs WHERE org_id = ?1 AND run_id = ?2 LIMIT 1',
  )
    .bind(orgId, runId)
    .first()
  if (!owns) return c.json({ error: 'run not found' }, 404)

  const rows = await c.env.DB.prepare(
    'SELECT seq, ts_ns, event_json FROM run_events WHERE run_id = ?1 ORDER BY seq',
  )
    .bind(runId)
    .all<{ seq: number; ts_ns: number; event_json: string }>()

  const stream = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder()
      for (const row of rows.results ?? []) {
        const envelope = `data: {"jsonrpc":"2.0","method":"events.append","params":${row.event_json}}\n\n`
        ctrl.enqueue(enc.encode(envelope))
      }
      ctrl.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  })
})

v1.get('/ws', (c) => {
  if (c.req.header('upgrade') !== 'websocket') {
    return c.json({ error: 'expected websocket upgrade' }, 426)
  }
  const runId = c.req.query('runId')
  if (!runId) return c.json({ error: 'missing runId query param' }, 400)

  const id = c.env.RUN_COORDINATOR.idFromName(runId)
  const stub = c.env.RUN_COORDINATOR.get(id)
  // Forward the upgrade request to the DO; it returns the 101 + WS pair.
  return stub.fetch(new URL('/ws', c.req.url).toString(), {
    headers: c.req.raw.headers,
  })
})

app.route('/v1', v1)

app.notFound((c) => c.json({ error: 'not found' }, 404))

app.onError((e, c) => {
  console.error('cloud error', e)
  return c.json({ error: 'internal error' }, 500)
})

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<QueuedEvent>, env: Env): Promise<void> {
    // Batched event insert: one statement per message to keep the example
    // legible; a real impl batches via D1 batch() or a single multi-VALUES.
    for (const msg of batch.messages) {
      const { runId, tsNs, eventJson } = msg.body
      try {
        await env.DB.prepare(
          'INSERT INTO run_events (run_id, seq, ts_ns, event_json) VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_events WHERE run_id = ?1), ?2, ?3)',
        )
          .bind(runId, tsNs, eventJson)
          .run()
        msg.ack()
      } catch (e) {
        console.error('queue insert failed', e)
        msg.retry()
      }
    }
  },
}

function artifactKey(orgId: string, hash: string): string {
  return `${orgId}/${hash}.tar.zst`
}

type MessageBatch<T> = {
  readonly messages: ReadonlyArray<{
    readonly body: T
    ack(): void
    retry(): void
  }>
}
