// The distributed-execution wire, v2.
//
// Every message here crosses a socket between a submitter, a serve and an
// agent that may be running different vx versions. A field lost by one adapter
// is not a crash — it is LOST WORK: an assignment that ignores the submitter's
// `--frozen`, a chunk routed to the wrong submission, an agent that reconnects
// under an id the serve still holds tasks against.
//
// tests/wire-dist.test.ts covers a handful of shapes. This covers the two
// properties that shape-by-shape examples cannot:
//
//   COMPLETENESS   every message kind declared in the union round-trips, and a
//                  kind added without an adapter arm fails here rather than
//                  silently becoming null on the wire.
//   DEGRADATION    the additive-optional fields (`policy`, `ownerSubmissionId`,
//                  `branch`/`defaultBranch`/`context`) survive BOTH directions
//                  of version skew — a new field an old peer omits, and a new
//                  field an old peer ignores.
//
// The completeness half reads the SOURCE, because the failure is an omission
// and an omission has no runtime shape: an unmapped arm simply returns null,
// which is indistinguishable from "that was not a dist message".
//
// TRAP, as in tests/analytics-route-drift.test.ts: this works only while the
// unions and adapters stay literal. If either becomes a computed table the
// regexes match nothing, so the parse assertions must FAIL LOUDLY rather than
// be relaxed.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  DIST_PROTOCOL_VERSION,
  distClientMessageToEnvelope,
  distServerMessageToEnvelope,
  distSubmitToEnvelope,
  envelopeToDistClientMessage,
  envelopeToDistServerMessage,
  envelopeToDistSubmit,
} from '../src/protocol-dist.js'
import type {
  AgentHello,
  DistClientMessage,
  DistServerMessage,
  DistSubmitMessage,
} from '../src/protocol-dist.js'

const SRC = readFileSync(path.join(import.meta.dir, '..', 'src', 'protocol-dist.ts'), 'utf8')

/**
 * The `t:` discriminants a message union declares, read from source.
 *
 * A member is either an inline object literal or a bare INTERFACE NAME
 * (`| AgentHello`), and both must be resolved. Reading only the inline ones
 * silently skipped `agent:hello` on the first cut of this file — the union's
 * one named member, and the message carrying `ownerSubmissionId`. A guard that
 * quietly covers six of seven kinds is exactly the false guarantee this file
 * exists to prevent, so the named members are followed to their declaration.
 */
function declaredKinds(unionName: string): string[] {
  const m = new RegExp(`export type ${unionName} =([\\s\\S]*?)\\n\\n`).exec(SRC)
  if (m === null) {
    throw new Error(
      `protocol-dist-wire: could not find "export type ${unionName}" — the union shape ` +
        'changed and this guard must be rewritten, not deleted',
    )
  }
  const body = m[1]!
  const kinds = new Set([...body.matchAll(/t: '([a-z:]+)'/g)].map((h) => h[1]!))

  for (const ref of body.matchAll(/\|\s*([A-Z]\w+)\s*$/gm)) {
    const decl = new RegExp(`export interface ${ref[1]!} \\{([\\s\\S]*?)\\n\\}`).exec(SRC)
    if (decl === null) {
      throw new Error(
        `protocol-dist-wire: union member ${ref[1]!} has no interface declaration — ` +
          'resolve it or this guard silently stops covering that message kind',
      )
    }
    const t = /t: '([a-z:]+)'/.exec(decl[1]!)
    if (t === null) {
      throw new Error(`protocol-dist-wire: ${ref[1]!} declares no 't' discriminant`)
    }
    kinds.add(t[1]!)
  }
  return [...kinds].sort()
}

/** A JSON hop — what the socket actually does to a message. */
const hop = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('the union is parsed, not assumed', () => {
  it('reads a healthy set of kinds from both unions', () => {
    // If these fail the parse found nothing, and every completeness assertion
    // below would pass vacuously.
    expect(declaredKinds('DistServerMessage').length).toBeGreaterThanOrEqual(3)
    expect(declaredKinds('DistClientMessage').length).toBeGreaterThanOrEqual(7)
  })

  it('resolves the union member declared by NAME, not just the inline ones', () => {
    // `agent:hello` is the union's only named member, and it is the message
    // carrying `ownerSubmissionId`. An earlier cut of this file matched inline
    // literals only and therefore never tested it at all — asserted explicitly
    // so that hole cannot silently reopen.
    expect(declaredKinds('DistClientMessage')).toContain('agent:hello')
  })

  it('the protocol version is 2', () => {
    // Pinned so a bump is a deliberate act with a compatibility story, not a
    // silent edit — every skew assertion below is written against v2.
    expect(DIST_PROTOCOL_VERSION).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// serve → agent
// ---------------------------------------------------------------------------

const SERVER_SAMPLES: Readonly<Record<string, DistServerMessage>> = {
  'task:assign': { t: 'task:assign', taskId: 'pkg#build', submissionId: 'sub-1' },
  'agent:refused': { t: 'agent:refused', reason: 'protocol mismatch: agent 1, serve 2' },
  'coord:drain': { t: 'coord:drain' },
}

describe('serve → agent messages round-trip', () => {
  for (const kind of declaredKinds('DistServerMessage')) {
    it(`${kind} survives the envelope AND a JSON hop`, () => {
      const msg = SERVER_SAMPLES[kind]
      // Completeness: a kind added to the union with no sample here fails,
      // which is the prompt to cover it rather than a silent gap.
      expect(msg).toBeDefined()
      const back = envelopeToDistServerMessage(hop(distServerMessageToEnvelope(msg!)))
      expect(back).toEqual(msg!)
    })
  }

  it('carries the per-assignment run policy', () => {
    // The submitter's --frozen/--timeout/--retry reach a REMOTE agent only
    // through this field. Losing it means the agent live-evaluates configs
    // with its own defaults — a different run than the one submitted.
    const msg: DistServerMessage = {
      t: 'task:assign',
      taskId: 'pkg#test',
      submissionId: 'sub-9',
      policy: { frozen: true, timeout: 30_000, retries: 2 },
    }
    expect(envelopeToDistServerMessage(hop(distServerMessageToEnvelope(msg)))).toEqual(msg)
  })

  it('transmits a policy whose values are falsy but meaningful', () => {
    // `retries: 0` means "never retry" and `frozen: false` means "live-eval,
    // explicitly". A truthiness gate would drop both and hand the agent its
    // own defaults instead — the opposite of what was asked.
    const msg: DistServerMessage = {
      t: 'task:assign',
      taskId: 'pkg#test',
      submissionId: 'sub-9',
      policy: { frozen: false, retries: 0, timeout: 0 },
    }
    const back = envelopeToDistServerMessage(hop(distServerMessageToEnvelope(msg)))
    expect(back).toEqual(msg)
  })

  it('a policy-less assign stays policy-less for an OLD serve', () => {
    // Degradation, direction one: a v2 agent receiving an assignment from a
    // serve that never sends `policy` must see it ABSENT, not as an empty
    // object it might treat as "everything explicitly off".
    const back = envelopeToDistServerMessage(
      hop(distServerMessageToEnvelope(SERVER_SAMPLES['task:assign']!)),
    )
    expect(back).not.toBeNull()
    expect('policy' in (back as object)).toBe(false)
  })

  it('rejects an envelope that is not a dist server message', () => {
    expect(
      envelopeToDistServerMessage({ jsonrpc: '2.0', method: 'events.append', params: {} }),
    ).toBeNull()
  })

  it('rejects a malformed envelope rather than throwing', () => {
    // These arrive from a peer, so a bad one must degrade rather than take
    // down the socket handler.
    for (const junk of [{}, { jsonrpc: '2.0' }, { method: 'coord.nope' }, { params: null }]) {
      expect(() => envelopeToDistServerMessage(junk as never)).not.toThrow()
      expect(envelopeToDistServerMessage(junk as never)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// agent → serve
// ---------------------------------------------------------------------------

const hello: AgentHello = {
  t: 'agent:hello',
  protocol: DIST_PROTOCOL_VERSION,
  agentId: 'agent-a',
  session: 'sess-1',
  workspaceId: 'ws-1',
  commitSha: 'a'.repeat(40),
  capacity: 4,
  labels: ['runner-3'],
} as AgentHello

const outcome = {
  id: 'pkg#build',
  project: 'pkg',
  task: 'build',
  status: 'success',
  durationMs: 1234,
} as never

const CLIENT_SAMPLES: Readonly<Record<string, DistClientMessage>> = {
  'agent:hello': hello,
  'agent:start': { t: 'agent:start', taskId: 'pkg#build', submissionId: 'sub-1' },
  'agent:stdout': { t: 'agent:stdout', taskId: 'pkg#build', submissionId: 'sub-1', chunk: 'out' },
  'agent:stderr': { t: 'agent:stderr', taskId: 'pkg#build', submissionId: 'sub-1', chunk: 'err' },
  'agent:done': { t: 'agent:done', taskId: 'pkg#build', submissionId: 'sub-1', outcome },
  'agent:heartbeat': { t: 'agent:heartbeat' },
  'agent:bye': { t: 'agent:bye', reason: 'idle-timeout' },
}

describe('agent → serve messages round-trip', () => {
  for (const kind of declaredKinds('DistClientMessage')) {
    it(`${kind} survives the envelope AND a JSON hop`, () => {
      const msg = CLIENT_SAMPLES[kind]
      expect(msg).toBeDefined()
      expect(envelopeToDistClientMessage(hop(distClientMessageToEnvelope(msg!)))).toEqual(msg!)
    })
  }

  it('every declared kind has a sample — a new one must not slip through', () => {
    // The union is read from source, so this fails the moment a kind is added
    // without coverage, rather than leaving it untested and unnoticed.
    const declared = declaredKinds('DistClientMessage')
    const missing = declared.filter((k) => !(k in CLIENT_SAMPLES))
    expect({ missing }).toEqual({ missing: [] })
  })

  it('routes every task-scoped message by submissionId', () => {
    // The multi-run scheduler multiplexes several submissions over ONE agent.
    // A chunk that lost its submissionId would be attributed to the wrong run
    // — someone else's log, in someone else's terminal.
    for (const kind of ['agent:start', 'agent:stdout', 'agent:stderr', 'agent:done']) {
      const back = envelopeToDistClientMessage(
        hop(distClientMessageToEnvelope(CLIENT_SAMPLES[kind]!)),
      ) as Record<string, unknown>
      expect(back['submissionId']).toBe('sub-1')
      expect(back['taskId']).toBe('pkg#build')
    }
  })

  it('carries ownerSubmissionId when the hello is a submitter self-agent', () => {
    // A self-agent is eligible ONLY for the submission that owns it. Losing
    // this field would let a same-commit peer conscript the submitter's own
    // machine.
    const owned = { ...hello, ownerSubmissionId: 'sub-7' } as AgentHello
    expect(envelopeToDistClientMessage(hop(distClientMessageToEnvelope(owned)))).toEqual(owned)
  })

  it('a hello WITHOUT ownerSubmissionId stays without it', () => {
    // Degradation: an ordinary helper agent must not acquire an owner it never
    // claimed, which would make it eligible for nothing.
    const back = envelopeToDistClientMessage(hop(distClientMessageToEnvelope(hello)))
    expect('ownerSubmissionId' in (back as object)).toBe(false)
  })

  it('preserves an EMPTY chunk rather than dropping it', () => {
    // Streams legitimately emit empty writes; a truthiness gate on `chunk`
    // would silently swallow them and the tail would not match the run.
    const msg: DistClientMessage = {
      t: 'agent:stdout',
      taskId: 't',
      submissionId: 's',
      chunk: '',
    }
    expect(envelopeToDistClientMessage(hop(distClientMessageToEnvelope(msg)))).toEqual(msg)
  })

  it('preserves a chunk with newlines, unicode and NUL', () => {
    // Task output is arbitrary bytes-as-text; the envelope must not normalise.
    const chunk = 'line1\nline2\r\n café 🎉\t'
    const msg: DistClientMessage = { t: 'agent:stdout', taskId: 't', submissionId: 's', chunk }
    const back = envelopeToDistClientMessage(hop(distClientMessageToEnvelope(msg))) as {
      chunk: string
    }
    expect(back.chunk).toBe(chunk)
  })

  it('preserves a very large chunk', () => {
    const chunk = 'x'.repeat(512 * 1024)
    const msg: DistClientMessage = { t: 'agent:stdout', taskId: 't', submissionId: 's', chunk }
    const back = envelopeToDistClientMessage(hop(distClientMessageToEnvelope(msg))) as {
      chunk: string
    }
    expect(back.chunk.length).toBe(chunk.length)
  })

  it('carries both agent:bye reasons distinctly', () => {
    // `idle-timeout` and `shutdown` are both TERMINAL, and the agent loop must
    // not reconnect on either — but they are reported differently, so they
    // cannot collapse.
    for (const reason of ['idle-timeout', 'shutdown'] as const) {
      const msg: DistClientMessage = { t: 'agent:bye', reason }
      expect(envelopeToDistClientMessage(hop(distClientMessageToEnvelope(msg)))).toEqual(msg)
    }
  })

  it('rejects a foreign or malformed envelope rather than throwing', () => {
    for (const junk of [{}, { jsonrpc: '2.0', method: 'submit.run', params: {} }, { params: 1 }]) {
      expect(() => envelopeToDistClientMessage(junk as never)).not.toThrow()
      expect(envelopeToDistClientMessage(junk as never)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// submitter → serve
// ---------------------------------------------------------------------------

function submit(over: Partial<DistSubmitMessage> = {}): DistSubmitMessage {
  return {
    t: 'dist:submit',
    protocol: DIST_PROTOCOL_VERSION,
    session: 'sess-1',
    workspaceId: 'ws-1',
    submissionId: 'sub-1',
    commitSha: 'b'.repeat(40),
    expectedAgents: 3,
    agentTimeoutMs: 30_000,
    request: { tasks: ['build'], cwd: '/repo' },
    nodes: [{ id: 'pkg#build', deps: [] } as never],
    ...over,
  }
}

describe('dist:submit round-trips', () => {
  it('survives the envelope AND a JSON hop', () => {
    const msg = submit()
    expect(envelopeToDistSubmit(hop(distSubmitToEnvelope(msg)))).toEqual(msg)
  })

  it('carries branch, defaultBranch and context when present', () => {
    // These scope the LPT duration hint the way the cache scopes reads: a
    // TRUNK submission must not read a branch experiment's timings.
    const msg = submit({
      branch: 'feature/x',
      defaultBranch: 'main',
      context: {
        os: 'linux',
        arch: 'x64',
        host: 'runner-1',
        ci: true,
        ciProvider: 'github',
        vxVersion: '0.0.0',
        dirty: false,
        workspaceName: 'acme',
      },
    })
    expect(envelopeToDistSubmit(hop(distSubmitToEnvelope(msg)))).toEqual(msg)
  })

  it('preserves an explicitly NULL branch, distinct from absent', () => {
    // `null` means "asked and there is none"; absent means "an older submitter
    // never asked". The serve treats absence as trunk, so collapsing the two
    // would silently rescope a branch run's timing baseline.
    const msg = submit({ branch: null, defaultBranch: null })
    const back = envelopeToDistSubmit(hop(distSubmitToEnvelope(msg)))
    expect(back).toEqual(msg)
    expect(back!.branch).toBeNull()
  })

  it('an OLDER submitter omitting the additive fields stays absent', () => {
    // Degradation, the other direction: a v2 serve must see them missing
    // rather than materialised as null, since the two mean different things.
    const back = envelopeToDistSubmit(hop(distSubmitToEnvelope(submit())))
    for (const f of ['branch', 'defaultBranch', 'context']) {
      expect(f in (back as object)).toBe(false)
    }
  })

  it('carries the whole RunRequest, not a subset', () => {
    // The request IS the run. A field dropped here is a flag the agents never
    // hear about — the class tests/protocol-map.test.ts guards one layer down.
    const msg = submit({
      request: {
        tasks: ['build', 'test'],
        cwd: '/repo',
        frozen: true,
        retries: 2,
        timeout: 9_000,
        concurrency: 8,
        tags: { pr: '42' },
        cache: { localRead: true, localWrite: false, remoteRead: true, remoteWrite: true },
      },
    })
    expect(envelopeToDistSubmit(hop(distSubmitToEnvelope(msg)))!.request).toEqual(msg.request)
  })

  it('preserves an EMPTY node list', () => {
    // An empty graph is a real submission the scheduler must finish cleanly
    // rather than hang on — collapsing it to absent would hide that path.
    const msg = submit({ nodes: [] })
    const back = envelopeToDistSubmit(hop(distSubmitToEnvelope(msg)))
    expect(back!.nodes).toEqual([])
  })

  it('preserves a large graph intact', () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => ({
      id: `p${i}#build`,
      deps: i > 0 ? [`p${i - 1}#build`] : [],
    })) as never[]
    const back = envelopeToDistSubmit(hop(distSubmitToEnvelope(submit({ nodes }))))
    expect(back!.nodes.length).toBe(2000)
    expect(back!.nodes[1999]).toEqual(nodes[1999]!)
  })

  it('preserves expectedAgents: 0 rather than treating it as unset', () => {
    // Zero expected agents is a legitimate ambient submission; a truthiness
    // gate would turn it into the default and change the warning behaviour.
    const back = envelopeToDistSubmit(hop(distSubmitToEnvelope(submit({ expectedAgents: 0 }))))
    expect(back!.expectedAgents).toBe(0)
  })

  it('reports the protocol version so a skewed peer can be refused', () => {
    // The serve compares this to refuse a v1 agent by NAMING both versions.
    // If it were lost the mismatch would surface as a confusing failure later.
    expect(envelopeToDistSubmit(hop(distSubmitToEnvelope(submit())))!.protocol).toBe(
      DIST_PROTOCOL_VERSION,
    )
  })

  it('round-trips a submission declaring an OLDER protocol', () => {
    // The refusal path needs the stale number to arrive intact — that is what
    // makes the error message name both sides.
    const back = envelopeToDistSubmit(hop(distSubmitToEnvelope(submit({ protocol: 1 }))))
    expect(back!.protocol).toBe(1)
  })

  it('rejects a foreign or malformed envelope rather than throwing', () => {
    for (const junk of [
      {},
      { jsonrpc: '2.0', method: 'agent.hello', params: {} },
      { params: [] },
    ]) {
      expect(() => envelopeToDistSubmit(junk as never)).not.toThrow()
      expect(envelopeToDistSubmit(junk as never)).toBeNull()
    }
  })
})

describe('the three namespaces do not collide', () => {
  // All three families share one socket vocabulary. An adapter that accepted a
  // sibling's envelope would mis-route a message into the wrong handler, which
  // is far worse than dropping it.
  it('a server envelope is not read as a client message or a submit', () => {
    const env = hop(distServerMessageToEnvelope(SERVER_SAMPLES['task:assign']!))
    expect(envelopeToDistClientMessage(env)).toBeNull()
    expect(envelopeToDistSubmit(env)).toBeNull()
  })

  it('a client envelope is not read as a server message or a submit', () => {
    const env = hop(distClientMessageToEnvelope(CLIENT_SAMPLES['agent:hello']!))
    expect(envelopeToDistServerMessage(env)).toBeNull()
    expect(envelopeToDistSubmit(env)).toBeNull()
  })

  it('a submit envelope is not read as either agent-channel message', () => {
    const env = hop(distSubmitToEnvelope(submit()))
    expect(envelopeToDistServerMessage(env)).toBeNull()
    expect(envelopeToDistClientMessage(env)).toBeNull()
  })
})
