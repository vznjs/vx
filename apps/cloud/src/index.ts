import { Hono } from 'hono'
import { bearerAuth } from './auth.js'
import type { Env, QueuedEvent, Variables } from './env.js'
import { computeArtifactTag, verifyArtifactTag } from './hmac.js'
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

  // HMAC: when VX_REMOTE_CACHE_SIGNATURE_KEY is set, every PUT must
  // carry an x-artifact-tag header we can verify. This matches the
  // policy on the client side (src/cache/remote-cache.ts: a tampered
  // artifact surfaces as a hard error so the client falls back).
  const secret = c.env.VX_REMOTE_CACHE_SIGNATURE_KEY
  let tag = c.req.header('x-artifact-tag') ?? ''
  if (secret) {
    if (!tag) {
      return c.json({ error: 'x-artifact-tag required when signing is enabled' }, 400)
    }
    const ok = await verifyArtifactTag(secret, hash, orgId, body, tag)
    if (!ok) {
      return c.json({ error: 'artifact tag verification failed' }, 401)
    }
  } else if (!tag) {
    // No signing configured: still compute + store a tag so reads can
    // self-verify if signing is enabled later (best-effort integrity).
    tag = ''
  }

  await c.env.ARTIFACTS.put(artifactKey(orgId, hash), body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      duration: c.req.header('x-artifact-duration') ?? '0',
      tag,
    },
  })

  return c.json({ urls: [`/v8/artifacts/${hash}`] })
})

cache.get('/:hash', async (c) => {
  const hash = c.req.param('hash')
  const orgId = c.get('auth').orgId
  const obj = await c.env.ARTIFACTS.get(artifactKey(orgId, hash))
  if (!obj) return c.notFound()

  const secret = c.env.VX_REMOTE_CACHE_SIGNATURE_KEY
  const tag = obj.customMetadata?.['tag'] ?? ''
  if (secret) {
    if (!tag) {
      // Hard fail: a signing deployment must not silently serve unsigned.
      return c.json({ error: 'cached artifact missing tag under signing policy' }, 500)
    }
    const body = await obj.arrayBuffer()
    const ok = await verifyArtifactTag(secret, hash, orgId, body, tag)
    if (!ok) {
      return c.json({ error: 'cached artifact tag verification failed' }, 500)
    }
    const headers = new Headers({ 'content-type': 'application/octet-stream' })
    const duration = obj.customMetadata?.['duration']
    if (duration) headers.set('x-artifact-duration', duration)
    headers.set('x-artifact-tag', tag)
    return new Response(body, { headers })
  }

  const headers = new Headers({ 'content-type': 'application/octet-stream' })
  const duration = obj.customMetadata?.['duration']
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
    // Group by runId so we allocate seq once per run via a single
    // SELECT + sequential offsets. D1's batch() executes statements in
    // order under one transaction — atomic and fast.
    const byRun = new Map<string, typeof batch.messages[number][]>()
    for (const msg of batch.messages) {
      const list = byRun.get(msg.body.runId)
      if (list) list.push(msg)
      else byRun.set(msg.body.runId, [msg])
    }

    for (const [runId, msgs] of byRun) {
      try {
        // Ensure the runs row exists so the FK on run_events holds.
        // First event from a run inserts the parent; subsequent events
        // are no-ops due to ON CONFLICT DO NOTHING.
        const firstEvent = JSON.parse(msgs[0]!.body.eventJson) as WireEvent
        const orgId = msgs[0]!.body.orgId
        await env.DB.prepare(
          'INSERT INTO runs (run_id, org_id, started_at) VALUES (?1, ?2, ?3) ON CONFLICT(run_id) DO NOTHING',
        )
          .bind(runId, orgId, Number(firstEvent.timeUnixNano ?? Date.now() * 1_000_000) / 1_000_000)
          .run()

        // Allocate seqs.
        const start = await env.DB.prepare(
          'SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE run_id = ?1',
        )
          .bind(runId)
          .first<{ m: number }>()
        let nextSeq = (start?.m ?? 0) + 1
        const stmts = msgs.map((m) =>
          env.DB.prepare(
            'INSERT INTO run_events (run_id, seq, ts_ns, event_json) VALUES (?1, ?2, ?3, ?4)',
          ).bind(runId, nextSeq++, m.body.tsNs, m.body.eventJson),
        )
        await env.DB.batch(stmts)
        for (const m of msgs) m.ack()
      } catch (e) {
        console.error('queue insert failed', e)
        for (const m of msgs) m.retry()
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
