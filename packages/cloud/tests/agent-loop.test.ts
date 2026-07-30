// The distributed agent loop (dist/agent-loop.ts) — the process a standing CI
// agent runs for hours. A defect here is a hung submission slot, a
// double-executed task, or an orphaned assignment, so this drives the REAL
// loop through its injected `wsFactory` seam (a fake socket opened/dropped on
// demand, no serve) and, for the assignment path, the REAL core `run()`
// against a throwaway git workspace — the only way to prove a per-assignment
// policy actually reaches the scoped run rather than being dropped on the way.
//
// Deliberately NOT re-covered here (owned elsewhere, do not duplicate):
//   - reconnect backoff / budget / flap / dwell / stop-mid-backoff and the
//     fresh-id-vs-previous-id comparison — `agent-reconnect.test.ts`;
//   - placement, relay and materialization across real agent subprocesses —
//     `agents-e2e.test.ts`;
//   - the envelope adapters over hand-written literals — `wire-dist.test.ts`
//     (the round-trip block below feeds it the frames the loop ACTUALLY
//     emitted, which is the half a literal-driven test cannot check).

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RemoteCacheLayer } from '@vzn/vx'
import {
  runAgentLoop,
  type AgentLoopOptions,
  type AgentSocket,
  type AgentSocketFactory,
} from '../src/dist/agent-loop.js'
import {
  DIST_PROTOCOL_VERSION,
  distClientMessageToEnvelope,
  envelopeToDistClientMessage,
  type DistClientMessage,
  type DistServerMessage,
} from '../src/protocol-dist.js'

// ---------------------------------------------------------------------------
// Fake socket harness — the `wsFactory` seam exists precisely so the
// connection lifecycle is drivable without a serve.
// ---------------------------------------------------------------------------

interface FakeSocket extends AgentSocket {
  /** Every frame the loop sent, parsed. */
  readonly sent: DistClientMessage[]
  closes: number
  /** Server accepted the upgrade. */
  open(): void
  /** Server → agent. */
  deliver(msg: DistServerMessage): void
  /** Raw bytes, for the malformed-frame case. */
  raw(data: string): void
  /** Peer/network dropped the socket. */
  drop(): void
}

function fakeFactory(onSend?: (msg: DistClientMessage) => void): {
  factory: AgentSocketFactory
  sockets: FakeSocket[]
} {
  const sockets: FakeSocket[] = []
  const factory: AgentSocketFactory = () => {
    const s: FakeSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      sent: [],
      closes: 0,
      send: (d) => {
        const msg = JSON.parse(d) as DistClientMessage
        s.sent.push(msg)
        onSend?.(msg)
      },
      close: () => {
        s.closes++
        s.onclose?.()
      },
      open: () => s.onopen?.(),
      deliver: (m) => s.onmessage?.({ data: JSON.stringify(m) }),
      raw: (d) => s.onmessage?.({ data: d }),
      drop: () => s.onclose?.(),
    }
    sockets.push(s)
    return s
  }
  return { factory, sockets }
}

const baseOpts = (
  factory: AgentSocketFactory,
  extra: Partial<AgentLoopOptions> = {},
): AgentLoopOptions => ({
  origin: 'http://serve.test',
  workspaceId: 'ws-1',
  session: 'sess-1',
  commitSha: 'cafebabe',
  capacity: 2,
  checkoutRoot: '/nonexistent',
  wsFactory: factory,
  // Short backoff so a reconnect materializes inside a poll bound rather than
  // the 500 ms default; never a bare sleep on an event.
  reconnectBaseMs: 5,
  ...extra,
})

type Frame<T extends DistClientMessage['t']> = Extract<DistClientMessage, { t: T }>

function framesOf<T extends DistClientMessage['t']>(sock: FakeSocket, t: T): Frame<T>[] {
  return sock.sent.filter((m): m is Frame<T> => m.t === t)
}

const kinds = (sock: FakeSocket): string[] => sock.sent.map((m) => m.t)

/** Poll a condition with a hard bound — never a bare sleep waiting on an event. */
async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

/** Resolves to the settled result, or the `'UNSETTLED'` sentinel if still running. */
async function settledWithin(loop: { done: Promise<unknown> }, ms: number): Promise<unknown> {
  return await Promise.race([loop.done, Bun.sleep(ms).then(() => 'UNSETTLED' as const)])
}

/** Deliver an assignment and wait for the `agent:done` it produces. */
async function assignAndWait(
  sock: FakeSocket,
  assign: Extract<DistServerMessage, { t: 'task:assign' }>,
): Promise<Frame<'agent:done'>> {
  const before = framesOf(sock, 'agent:done').length
  sock.deliver(assign)
  await until(() => framesOf(sock, 'agent:done').length > before, `agent:done for ${assign.taskId}`)
  return framesOf(sock, 'agent:done').at(-1)!
}

// ---------------------------------------------------------------------------
// Throwaway workspaces. Real runs are the only way to prove a per-assignment
// policy reached the scoped `run()`; a mocked run would pin the mock.
// ---------------------------------------------------------------------------

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.all(tempRoots.map((d) => rm(d, { recursive: true, force: true })))
})

function gitInit(root: string): void {
  const g = (...a: string[]): void => {
    Bun.spawnSync({ cmd: ['git', ...a], cwd: root, stdout: 'ignore', stderr: 'ignore' })
  }
  g('init', '-q')
  g('config', 'user.email', 't@vx.local')
  g('config', 'user.name', 'vx test')
  g('add', '-A')
  g('commit', '-qm', 'init')
}

/**
 * A single-project workspace whose one task is `solo#build`. vx hard-requires
 * git for input enumeration, so the fixture commits — and outputs are
 * gitignored, like every real workspace, so the tree stays clean.
 */
async function soloWorkspace(command: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-agentloop-solo-'))
  tempRoots.push(root)
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'solo', version: '0.0.0' }),
  )
  await writeFile(path.join(root, 'src', 'in.txt'), 'v1')
  await writeFile(path.join(root, '.gitignore'), '.vx/\nout.txt\nattempts.txt\n')
  await writeFile(
    path.join(root, 'vx.config.mjs'),
    `export default { tasks: { build: {
       exec: { command: ${JSON.stringify(command)} },
       cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
     } } }`,
  )
  gitInit(root)
  return root
}

/** Two packages, `downstream#build` depending on `upstream#build` via `^build`. */
async function depWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-agentloop-dep-'))
  tempRoots.push(root)
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'wsroot', private: true }),
  )
  await writeFile(path.join(root, '.gitignore'), '.vx/\nout.txt\n')
  const pkgs = [
    { name: 'upstream', deps: {}, marker: 'MARK-UPSTREAM', dependsOn: '[]' },
    {
      name: 'downstream',
      deps: { upstream: 'workspace:*' },
      marker: 'MARK-DOWNSTREAM',
      dependsOn: "['^build']",
    },
  ]
  for (const p of pkgs) {
    const dir = path.join(root, 'packages', p.name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: p.name, version: '0.0.0', dependencies: p.deps }),
    )
    await writeFile(path.join(dir, 'src', 'in.txt'), `${p.name}-v1`)
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: 'echo ${p.marker} && echo built > out.txt' },
         dependsOn: ${p.dependsOn},
         cache: { inputs: { files: ['src/**'], tasks: ['^*'] }, outputs: { files: ['out.txt'] } },
       } } }`,
    )
  }
  gitInit(root)
  return root
}

// ---------------------------------------------------------------------------

describe('agent loop — the hello frame (registration identity)', () => {
  it('carries the full registration identity + the protocol sentinel, and nothing else', () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory))
    sockets[0]!.open()

    const hello = framesOf(sockets[0]!, 'agent:hello')[0]!
    // Every field the serve's `registry.hello` reads to build a RegisteredAgent:
    // a dropped one is not a crash, it is an agent registered under the wrong
    // session/commit — i.e. silently ineligible for the work it exists to do.
    expect(hello).toEqual({
      t: 'agent:hello',
      protocol: DIST_PROTOCOL_VERSION,
      agentId: expect.any(String),
      workspaceId: 'ws-1',
      session: 'sess-1',
      commitSha: 'cafebabe',
      capacity: 2,
    })
    // The two optional fields must be ABSENT (not `undefined`, not empty) when
    // unset — `agent:hello` is a wire frame, and the serve distinguishes a
    // standing helper from a submitter self-agent purely by their presence.
    expect('labels' in hello).toBe(false)
    expect('ownerSubmissionId' in hello).toBe(false)
    loop.stop()
  })

  it('ships labels only when non-empty — an empty array is omitted', () => {
    const empty = fakeFactory()
    const l1 = runAgentLoop(baseOpts(empty.factory, { labels: [] }))
    empty.sockets[0]!.open()
    // `parseAgentArgs` yields `labels: []` when no --label is passed, and the
    // submitter always passes one; an unconditional spread would put `[]` on
    // every standing agent's hello, which the serve stores as a label set.
    expect('labels' in framesOf(empty.sockets[0]!, 'agent:hello')[0]!).toBe(false)
    l1.stop()

    const some = fakeFactory()
    const l2 = runAgentLoop(baseOpts(some.factory, { labels: ['linux-x64', 'big'] }))
    some.sockets[0]!.open()
    expect(framesOf(some.sockets[0]!, 'agent:hello')[0]!.labels).toEqual(['linux-x64', 'big'])
    l2.stop()
  })

  it('a submitter self-agent names its owner submission; a standing agent does not', () => {
    const self = fakeFactory()
    const l1 = runAgentLoop(baseOpts(self.factory, { ownerSubmissionId: 'sub-7' }))
    self.sockets[0]!.open()
    // The eligibility key: without it a same-commit PEER submission can
    // conscript this machine, which is the whole reason the field exists.
    expect(framesOf(self.sockets[0]!, 'agent:hello')[0]!.ownerSubmissionId).toBe('sub-7')
    l1.stop()

    const standing = fakeFactory()
    const l2 = runAgentLoop(baseOpts(standing.factory))
    standing.sockets[0]!.open()
    // A standing helper must stay unowned or it serves exactly one submission.
    expect(framesOf(standing.sockets[0]!, 'agent:hello')[0]!.ownerSubmissionId).toBeUndefined()
    l2.stop()
  })
})

describe('agent loop — agent identity across reconnects', () => {
  it('honours a caller-pinned agentId on the FIRST connection only', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { agentId: 'pinned-id', maxReconnects: 5 }))

    sockets[0]!.open()
    expect(framesOf(sockets[0]!, 'agent:hello')[0]!.agentId).toBe('pinned-id')

    // The serve reassigns a dropped socket's in-flight tasks when its close
    // fires, and `drop` no-ops on an id mismatch — so a reconnect that REUSED
    // the pinned id could overwrite the still-pending old registration and
    // orphan its tasks. Every reconnect must mint a fresh id, forever, not
    // just on the first one.
    for (let i = 1; i <= 2; i++) {
      sockets[i - 1]!.drop()
      await until(() => sockets.length === i + 1, `reconnect #${i}`)
      sockets[i]!.open()
    }
    const ids = sockets.map((s) => framesOf(s, 'agent:hello')[0]!.agentId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(ids.slice(1)).not.toContain('pinned-id')

    loop.stop()
    expect(await loop.done).toEqual({ ok: true, reason: 'stopped' })
  })
})

describe('agent loop — idle timeout (terminal: never reconnects)', () => {
  it('says bye(idle-timeout), and the close settles idle-timeout without a reconnect', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { idleTimeoutMs: 40, maxReconnects: 5 }))
    sockets[0]!.open()

    expect(await loop.done).toEqual({ ok: true, reason: 'idle-timeout' })
    // The reason on the wire is what tells the serve this was a planned
    // departure rather than a crash it should reassign around.
    expect(framesOf(sockets[0]!, 'agent:bye')[0]!.reason).toBe('idle-timeout')
    expect(sockets[0]!.closes).toBe(1)
    // Terminal: an agent that just chose to leave must not immediately dial
    // back in (reconnect is ON here — the budget is untouched, so a missing
    // `idleFired` check in onclose reconnects forever).
    await Bun.sleep(30)
    expect(sockets).toHaveLength(1)
  })

  it('never self-terminates when no idle timeout is configured', async () => {
    const { factory, sockets } = fakeFactory()
    // The submitter's in-process loop passes no idleTimeoutMs and must live
    // for the whole submission; `setTimeout(fn, undefined)` fires on the next
    // tick, so the "unset" guard is the only thing between it and an
    // immediate suicide.
    const loop = runAgentLoop(baseOpts(factory, { ownerSubmissionId: 'sub-1' }))
    sockets[0]!.open()

    expect(await settledWithin(loop, 120)).toBe('UNSETTLED')
    expect(kinds(sockets[0]!)).toEqual(['agent:hello'])
    loop.stop()
  })

  it('an in-flight assignment suppresses the idle bye; the timer re-arms only after it reports done', async () => {
    const root = await soloWorkspace('sleep 1 && echo built > out.txt')
    const { factory, sockets } = fakeFactory()
    // The task outlives the idle window by ~1 s, so an agent that let the idle
    // timer run while working would say bye MID-TASK — abandoning a task the
    // serve believes is in flight.
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root, idleTimeoutMs: 300 }))
    sockets[0]!.open()
    await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-1',
    })

    const order = kinds(sockets[0]!)
    expect(order.indexOf('agent:bye')).toBe(-1)

    // …and once the task IS done the agent goes back to being idle: the timer
    // re-arms, so a helper that finishes its work still releases the slot.
    expect(await loop.done).toEqual({ ok: true, reason: 'idle-timeout' })
    const final = kinds(sockets[0]!)
    expect(final.indexOf('agent:done')).toBeLessThan(final.indexOf('agent:bye'))
  }, 30_000)
})

describe('agent loop — drain', () => {
  it('an idle agent drains immediately: bye(shutdown), settled drained, no reconnect', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { maxReconnects: 5 }))
    sockets[0]!.open()
    sockets[0]!.deliver({ t: 'coord:drain' })

    expect(await loop.done).toEqual({ ok: true, reason: 'drained' })
    expect(framesOf(sockets[0]!, 'agent:bye')[0]!.reason).toBe('shutdown')
    // `ok: true` is the contract the `vx-cloud agent` verb turns into exit 0:
    // a drained matrix row is a clean shutdown, not infra failure.
    await Bun.sleep(30)
    expect(sockets).toHaveLength(1)
  })

  it('a drain during an assignment waits for the task before saying bye', async () => {
    const root = await soloWorkspace('sleep 1 && echo built > out.txt')
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root }))
    sockets[0]!.open()

    sockets[0]!.deliver({ t: 'task:assign', taskId: 'solo#build', submissionId: 'sub-1' })
    await until(() => framesOf(sockets[0]!, 'agent:start').length === 1, 'agent:start')
    // Drain mid-task: the serve is asking the pool to wind down, but this
    // agent still holds work the submission is waiting on. Saying bye now
    // would strand that task with an outcome nobody ever hears.
    sockets[0]!.deliver({ t: 'coord:drain' })
    expect(kinds(sockets[0]!)).not.toContain('agent:bye')

    expect(await loop.done).toEqual({ ok: true, reason: 'drained' })
    const order = kinds(sockets[0]!)
    expect(order.indexOf('agent:done')).toBeLessThan(order.indexOf('agent:bye'))
  }, 30_000)
})

describe('agent loop — terminal classification', () => {
  it('a refusal outranks a drain that races it', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory))
    sockets[0]!.open()
    // Both flags end up set before the close is classified. The refusal must
    // win: it is the only reason that reports `ok: false`, and the CLI turns
    // that into exit 1. Classified as a drain instead, a protocol-mismatched
    // agent exits 0 and a misconfigured CI matrix goes green.
    sockets[0]!.deliver({ t: 'agent:refused', reason: 'protocol mismatch: v1 vs v2' })
    sockets[0]!.deliver({ t: 'coord:drain' })

    expect(await loop.done).toEqual({ ok: false, reason: 'refused' })
  })

  it('settles on the refusal FRAME, not on a close the serve may never send', async () => {
    // A refusal is terminal by definition — `onclose` already treats it as such
    // and never reconnects — so waiting for the serve to close is waiting on
    // something this side cannot make happen. Today's serve does close
    // (dist/registry.ts:237); one that refuses and holds the socket open (a
    // bug, a foreign implementation, a proxy that keeps it half-open) used to
    // leave `done` pending, and `agentCmd` awaits `done`.
    //
    // The sharp case is `--idle-timeout 0`, which is how a STANDING pool agent
    // is run: `armIdle` returns early with no timer, so nothing else was ever
    // going to settle it and the job sat until CI killed it. Measured before
    // the fix: still pending after 3 s with no timer armed anywhere.
    const { factory, sockets } = fakeFactory()
    // No idleTimeoutMs — the standing-agent shape, and the one with no backstop.
    const loop = runAgentLoop(baseOpts(factory))
    sockets[0]!.open()
    sockets[0]!.deliver({ t: 'agent:refused', reason: 'protocol mismatch: v1 vs v2' })

    expect(await loop.done).toEqual({ ok: false, reason: 'refused' })
    // And it drops the socket itself rather than leaking it for the life of the
    // process — the close is not the serve's to own.
    expect(sockets[0]!.closes).toBe(1)
  })

  it('a refusal the serve DOES close still settles exactly once, with the same reason', async () => {
    // The control: `settle` is idempotent, so the frame-side settle plus the
    // close it triggers plus the serve's own close must not fight. Without
    // that, the fix above would trade a hang for a double-resolve.
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory))
    sockets[0]!.open()
    sockets[0]!.deliver({ t: 'agent:refused', reason: 'protocol mismatch: v1 vs v2' })
    sockets[0]!.close()

    expect(await loop.done).toEqual({ ok: false, reason: 'refused' })
  })

  it('a garbage or unknown frame is ignored — it can neither throw nor settle', async () => {
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory))
    sockets[0]!.open()

    // A throw out of `onmessage` on a real WebSocket is an unhandled error on
    // the agent's only event source; a long-lived agent must survive whatever
    // arrives on the socket.
    expect(() => sockets[0]!.raw('not json{')).not.toThrow()
    expect(() => sockets[0]!.raw('123')).not.toThrow()
    expect(() => sockets[0]!.raw('"a string"')).not.toThrow()
    expect(() => sockets[0]!.raw('[]')).not.toThrow()
    expect(() =>
      sockets[0]!.deliver({ t: 'coord:unknown' } as unknown as DistServerMessage),
    ).not.toThrow()

    expect(await settledWithin(loop, 60)).toBe('UNSETTLED')
    expect(kinds(sockets[0]!)).toEqual(['agent:hello'])
    loop.stop()
  })

  it('a literal `null` frame is ignored like every other non-object', async () => {
    // `null` was the lone hole in the parse guard, and the only JSON value with
    // this property: parsing succeeds so the try/catch never fires, and the
    // very next line — `msg.t` — throws `TypeError: null is not an object`
    // straight out of the handler. `123`, `"str"`, `[]` and `true` all answer
    // `undefined` for `.t` and fall through harmlessly, which is why the hole
    // survived. On a real socket that throw is an UNCAUGHT error with a stack
    // trace on the agent's stderr, from one untrusted frame — and the WS
    // payload is a system boundary (the agent dials whatever `--url` names,
    // possibly through a proxy), which is exactly why the parse was guarded in
    // the first place.
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory))
    sockets[0]!.open()

    expect(() => sockets[0]!.raw('null')).not.toThrow()
    // Ignored, not merely survived: no reply, no settle, and a real frame
    // arriving afterwards is still dispatched.
    expect(await settledWithin(loop, 60)).toBe('UNSETTLED')
    expect(kinds(sockets[0]!)).toEqual(['agent:hello'])
    // A real frame arriving afterwards is still dispatched. `coord:drain` on
    // purpose rather than `agent:refused`: drain settles through the close
    // path, so this test stays independent of the refusal fix beside it and a
    // differential can attribute a failure to one or the other.
    sockets[0]!.deliver({ t: 'coord:drain' })
    expect(await loop.done).toEqual({ ok: true, reason: 'drained' })
  })
})

describe('agent loop — assignment execution and outcome reporting', () => {
  it('runs the real scoped pipeline and reports start/stdout/done, every frame carrying its submissionId', async () => {
    const root = await soloWorkspace('echo MARK-OUT && echo built > out.txt')
    const assigned: string[] = []
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(
      baseOpts(factory, { checkoutRoot: root, onAssigned: (t) => assigned.push(t) }),
    )
    sockets[0]!.open()

    const done = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-42',
    })

    expect(assigned).toEqual(['solo#build'])
    expect(kinds(sockets[0]!)).toEqual(['agent:hello', 'agent:start', 'agent:stdout', 'agent:done'])
    expect(framesOf(sockets[0]!, 'agent:stdout')[0]!.chunk).toContain('MARK-OUT')
    expect(done.outcome.status).toBe('success')
    expect(done.outcome.exitCode).toBe(0)
    // The cache key rides the outcome — it is what the serve prunes future
    // dispatches against, so an outcome without one silently disables the
    // warm-rerun path.
    expect(done.outcome.hash).toMatch(/^[0-9a-f]{16}$/)
    // One agent multiplexes several concurrent submissions; a task-scoped
    // frame that loses its submissionId is routed to the wrong submitter (or
    // nowhere).
    for (const m of sockets[0]!.sent) {
      if (m.t !== 'agent:hello') expect(m).toHaveProperty('submissionId', 'sub-42')
    }

    loop.stop()
  }, 30_000)

  it('forwards ONLY the assigned task’s output — its dependency stays silent', async () => {
    const root = await depWorkspace()
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root }))
    sockets[0]!.open()

    // The scoped run executes the dep closure too (that is what keeps the keys
    // honest), so BOTH tasks emit on the bus — verified directly against core.
    // Forwarding the upstream's chunks would attribute another task's output
    // to the assigned one in the submitter's terminal, and would duplicate it
    // once the upstream's own agent reports.
    const done = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'downstream#build',
      submissionId: 'sub-1',
    })

    expect(done.outcome.status).toBe('success')
    const streamed = framesOf(sockets[0]!, 'agent:stdout')
      .map((m) => m.chunk)
      .join('')
    expect(streamed).toContain('MARK-DOWNSTREAM')
    expect(streamed).not.toContain('MARK-UPSTREAM')
    // …and the upstream never gets an outcome of its own from this agent.
    expect(framesOf(sockets[0]!, 'agent:done').map((m) => m.taskId)).toEqual(['downstream#build'])

    loop.stop()
  }, 30_000)

  it('reports a failed outcome for a task the workspace does not declare, instead of stalling', async () => {
    const root = await soloWorkspace('echo MARK-OUT && echo built > out.txt')
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root }))
    sockets[0]!.open()

    // An unresolved task id makes core `run()` return `ok:false` with ZERO
    // outcomes, so there is no outcome to project. The submission slot is held
    // until this agent answers, so the synthesized failure is the difference
    // between a red run and a hung one.
    const done = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'ghost#build',
      submissionId: 'sub-1',
    })

    expect(done.outcome).toEqual({
      taskId: 'ghost#build',
      status: 'failed',
      exitCode: 1,
      durationMs: 0,
    })
    loop.stop()
  }, 30_000)

  it('reports a THROWING run as a failed outcome and puts the error on agent:stderr', async () => {
    const root = await soloWorkspace('echo MARK-OUT && echo built > out.txt')
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root }))
    sockets[0]!.open()

    // `--frozen` with no committed lockfile throws out of `run()` before any
    // task starts. The submitter only ever sees this agent's frames, so an
    // unforwarded message is an unexplained red task.
    const done = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-1',
      policy: { frozen: true },
    })

    expect(done.outcome.status).toBe('failed')
    expect(done.outcome.exitCode).toBe(1)
    const stderr = framesOf(sockets[0]!, 'agent:stderr')
      .map((m) => m.chunk)
      .join('')
    expect(stderr).toContain('--frozen requires vx-lock.json')
    loop.stop()
  }, 30_000)
})

describe('agent loop — per-assignment run policy', () => {
  it('applies the assignment’s policy to the scoped run; a policy-less assignment is untouched', async () => {
    const root = await soloWorkspace('echo MARK-OUT && echo built > out.txt')
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root }))
    sockets[0]!.open()

    // One standalone agent serves several concurrent submissions, so the
    // policy has to be applied PER ASSIGNMENT — not once at startup. The same
    // agent, same workspace, same task: the only difference is the policy.
    const frozen = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-frozen',
      policy: { frozen: true },
    })
    expect(frozen.outcome.status).toBe('failed')

    const live = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-live',
    })
    expect(live.outcome.status).toBe('success')

    loop.stop()
  }, 30_000)

  it('falls back to the loop’s own frozen for a bare assignment, and an explicit policy overrides it', async () => {
    const root = await soloWorkspace('echo MARK-OUT && echo built > out.txt')
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root, frozen: true }))
    sockets[0]!.open()

    // Bare assignment = an older serve that does not send a policy: the
    // agent's own configured value is the documented fallback.
    const bare = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-bare',
    })
    expect(bare.outcome.status).toBe('failed')

    // `policy?.frozen ?? opts.frozen` — nullish, not `||`. An explicit
    // `frozen: false` from the submitter is a real instruction, and `||` would
    // silently discard it and freeze a run that asked to live-evaluate.
    const explicit = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-explicit',
      policy: { frozen: false },
    })
    expect(explicit.outcome.status).toBe('success')

    loop.stop()
  }, 30_000)

  it('threads policy.retries into the scoped run as the run-level retry default', async () => {
    const root = await soloWorkspace('')
    const attempts = path.join(root, 'attempts.txt')
    // Rewrite the task now that the (gitignored, glob-excluded) evidence path
    // is known — it is neither an input nor a declared output, so nothing
    // hashes or cleans it between attempts.
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      `export default { tasks: { build: {
         exec: { command: ${JSON.stringify(`echo x >> ${attempts} && exit 3`)} },
         cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
       } } }`,
    )
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root }))
    sockets[0]!.open()

    const done = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-1',
      policy: { retries: 2 },
    })

    expect(done.outcome.status).toBe('failed')
    expect(done.outcome.exitCode).toBe(3)
    // retries = ADDITIONAL attempts, so 2 means the body ran three times. A
    // dropped `retries` reads as 1 here — the flaky-task mitigation the
    // submitter asked for, silently absent on every remote agent.
    const ran = (await readFile(attempts, 'utf8')).trimEnd().split('\n')
    expect(ran).toHaveLength(3)

    loop.stop()
  }, 30_000)

  it('threads policy.timeout into the scoped run so a runaway task is bounded', async () => {
    const root = await soloWorkspace('sleep 6')
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root }))
    sockets[0]!.open()

    const started = Date.now()
    const done = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-1',
      policy: { timeout: 300 },
    })
    const elapsed = Date.now() - started

    // The task sleeps 6 s; the submitter's --timeout is the only thing that
    // ends it. Without the field the assignment runs to completion and
    // reports success, so both halves of this are load-bearing.
    expect(done.outcome.status).toBe('failed')
    expect(elapsed).toBeLessThan(4_000)

    loop.stop()
  }, 30_000)
})

describe('agent loop — the artifact-transport gate (§6.3)', () => {
  it('uploads the artifact through the injected remote layer BEFORE agent:done leaves the socket', async () => {
    const root = await soloWorkspace('echo MARK-OUT && echo built > out.txt')
    const puts: string[] = []
    const remote: RemoteCacheLayer = {
      has: () => Promise.resolve(false),
      get: () => Promise.resolve(null),
      put: (hash) => {
        puts.push(hash)
        return Promise.resolve()
      },
    }
    // Sampled at the instant the frame is handed to the socket, not after —
    // the ordering IS the invariant.
    let putsWhenDoneSent = -1
    const { factory, sockets } = fakeFactory((m) => {
      if (m.t === 'agent:done') putsWhenDoneSent = puts.length
    })
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root, remoteCache: remote }))
    sockets[0]!.open()

    const done = await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-1',
    })

    // `run()` drains its background uploads before resolving, which is what
    // makes "send done after run() resolves" an await-PUT-before-done gate.
    // If done raced the upload, the submitter would materialize outputs from
    // a store that does not have them yet — a green run with missing files.
    expect(putsWhenDoneSent).toBe(1)
    expect(puts).toEqual([done.outcome.hash!])

    loop.stop()
  }, 30_000)
})

describe('agent loop — wire round-trip of the frames it actually emits', () => {
  it('every emitted frame survives the envelope adapters unchanged', async () => {
    const root = await soloWorkspace('echo MARK-OUT && echo built > out.txt')
    const { factory, sockets } = fakeFactory()
    const loop = runAgentLoop(baseOpts(factory, { checkoutRoot: root, labels: ['linux-x64'] }))
    sockets[0]!.open()
    await assignAndWait(sockets[0]!, {
      t: 'task:assign',
      taskId: 'solo#build',
      submissionId: 'sub-1',
    })
    sockets[0]!.deliver({ t: 'coord:drain' })
    await loop.done

    // wire-dist.test.ts round-trips hand-written literals; this feeds the
    // adapters the frames the loop REALLY produced, so a field the loop sends
    // but the adapter drops (or vice versa) is caught. A silently dropped
    // field here is a distribution failure with no error anywhere.
    expect(kinds(sockets[0]!)).toEqual([
      'agent:hello',
      'agent:start',
      'agent:stdout',
      'agent:done',
      'agent:bye',
    ])
    for (const frame of sockets[0]!.sent) {
      const back = envelopeToDistClientMessage(distClientMessageToEnvelope(frame))
      expect(back).toEqual(frame)
    }
    // The outcome is the payload the serve records verbatim; prove the
    // structured fields (not just the scalars) made the trip.
    const roundTripped = envelopeToDistClientMessage(
      distClientMessageToEnvelope(framesOf(sockets[0]!, 'agent:done')[0]!),
    ) as Frame<'agent:done'>
    expect(roundTripped.outcome.hash).toMatch(/^[0-9a-f]{16}$/)
  }, 30_000)
})

describe('agent loop — timer hygiene', () => {
  // The loop's timers are unref'd so a pending retry can never delay process
  // exit. That has no in-process shape to assert (a Timeout does not expose
  // its ref state), but it has a decisive out-of-process one: a subprocess
  // that arms the timers and reaches the end of its script must EXIT. With a
  // single missing `.unref?.()` it instead waits out the backoff — verified:
  // dropping the reconnect unref takes this from ~80 ms to ~8 s (the backoff
  // cap), and dropping the heartbeat unref hangs forever (it is an interval).
  //
  // FINDING (packages/cloud/src/dist/agent-loop.ts:250, protocol-dist.ts:46):
  // AGENT_HEARTBEAT_MS (10 s) is a module constant with no option or env
  // override, unlike every other timing in the loop (`reconnectBaseMs`,
  // `reconnectStableMs`, `maxReconnects`, `idleTimeoutMs`). So the heartbeat
  // CADENCE — the liveness signal the serve reaps a partitioned agent on —
  // cannot be observed by a test without a 10 s wall-clock wait, and neither
  // can `stop()` clearing the interval. Correct would be an
  // `AgentLoopOptions.heartbeatMs` (default AGENT_HEARTBEAT_MS), matching the
  // reconnect knobs. Only the unref half is reachable today, below.
  let scriptDir: string | undefined

  async function armScript(): Promise<string> {
    if (scriptDir === undefined) {
      scriptDir = await mkdtemp(path.join(tmpdir(), 'vx-agentloop-exit-'))
      tempRoots.push(scriptDir)
    }
    const loopModule = path.join(import.meta.dir, '..', 'src', 'dist', 'agent-loop.ts')
    const file = path.join(scriptDir, 'arm-timers.ts')
    await writeFile(
      file,
      `import { runAgentLoop } from ${JSON.stringify(loopModule)}
let sock
const loop = runAgentLoop({
  origin: 'http://serve.test', workspaceId: 'ws', session: 's', commitSha: 'c',
  capacity: 1, checkoutRoot: '/w',
  // Long enough that a ref'd timer visibly outlives the script.
  reconnectBaseMs: 30_000, reconnectStableMs: 30_000, idleTimeoutMs: 30_000,
  wsFactory: () => {
    sock = { onopen: null, onmessage: null, onclose: null, onerror: null,
             send: () => {}, close: () => {} }
    return sock
  },
})
void loop
sock.onopen?.()                                   // heartbeat + dwell + idle armed
if (process.argv[2] === 'backoff') sock.onclose?.() // …swapped for a reconnect backoff
`,
    )
    return file
  }

  async function msToExit(mode: 'open' | 'backoff', killAfterMs: number): Promise<number> {
    const file = await armScript()
    const started = Date.now()
    const proc = Bun.spawn({ cmd: ['bun', file, mode], stdout: 'ignore', stderr: 'pipe' })
    // A hang must fail the assertion, never wedge the suite.
    const killer = setTimeout(() => proc.kill(9), killAfterMs)
    try {
      await proc.exited
    } finally {
      clearTimeout(killer)
    }
    return Date.now() - started
  }

  it('a pending reconnect backoff does not keep the process alive', async () => {
    expect(await msToExit('backoff', 9_000)).toBeLessThan(3_000)
  }, 30_000)

  it('an open connection’s heartbeat, dwell and idle timers do not keep the process alive', async () => {
    expect(await msToExit('open', 9_000)).toBeLessThan(3_000)
  }, 30_000)
})
