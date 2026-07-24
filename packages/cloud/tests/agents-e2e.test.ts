// The real distributed-execution e2e (distributed-execution-2026-07 §11):
// one serve (token + artifact store), TWO `vx-cloud agent` subprocesses on
// separate `git clone`s of the fixture at the same commit, and a
// distribute submission from the fixture origin. Asserts placement across
// both agents, event streaming back to the submitter, artifact upload,
// output materialization on the submitter, the §6.3 payoff (a WARM rerun
// dispatches ZERO assignments), and mid-run agent-death reassignment.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureWorkspaceIdentity, type Logger, type TaskNode, type TaskOutcome } from '@vzn/vx'
import { distributedBackend } from '../src/dist/submit.js'
import { bootPlatform } from './helpers/platform.js'

const TIMEOUT = 120_000
const BIN = path.join(import.meta.dir, '..', 'src', 'cli', 'bin.ts')

const ENV_KEYS = ['VX_CLOUD_AGENT', 'VX_AGENT_SESSION', 'VX_CLOUD_DISTRIBUTE']
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

interface Fixture {
  origin: string
  packages: string[]
}

/**
 * 4 independent cacheable tasks + one dependent on all of them. Outputs
 * are gitignored (like every real workspace) so built trees stay CLEAN —
 * the dirty gate is about uncommitted INPUTS. The origin adds itself as
 * its own `remote.origin.url` so the submitter and the clones derive the
 * same workspace id.
 */
async function makeFixture(slow: boolean): Promise<Fixture> {
  const origin = await mkdtemp(path.join(tmpdir(), 'vx-agents-origin-'))
  await writeFile(path.join(origin, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(origin, 'package.json'),
    JSON.stringify({ name: 'agents-fixture', private: true }),
  )
  await writeFile(path.join(origin, '.gitignore'), 'out.txt\n.vx/\n')

  const names = ['p1', 'p2', 'p3', 'p4']
  for (const name of names) {
    const dir = path.join(origin, 'packages', name)
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
    await writeFile(path.join(dir, 'src', 'in.txt'), `${name}-v1`)
    const cmd = slow
      ? `echo building-${name} && sleep 3 && echo built-${name} > out.txt`
      : `echo building-${name} && sleep 1 && echo built-${name} > out.txt`
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default {
         tasks: {
           build: {
             exec: { command: '${cmd}' },
             cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
           },
         },
       }`,
    )
  }
  const p5 = path.join(origin, 'packages', 'p5')
  await mkdir(path.join(p5, 'src'), { recursive: true })
  await writeFile(
    path.join(p5, 'package.json'),
    JSON.stringify({
      name: 'p5',
      version: '0.0.0',
      dependencies: { p1: 'workspace:*', p2: 'workspace:*', p3: 'workspace:*', p4: 'workspace:*' },
    }),
  )
  await writeFile(path.join(p5, 'src', 'in.txt'), 'p5-v1')
  await writeFile(
    path.join(p5, 'vx.config.mjs'),
    `export default {
       tasks: {
         build: {
           exec: { command: 'echo building-p5 && echo built-p5 > out.txt' },
           dependsOn: ['^build'],
           cache: { inputs: { files: ['src/**'], tasks: ['^*'] }, outputs: { files: ['out.txt'] } },
         },
       },
     }`,
  )

  const git = (...args: string[]) => Bun.spawnSync({ cmd: ['git', ...args], cwd: origin })
  git('init', '-q')
  git('config', 'user.email', 't@vx.local')
  git('config', 'user.name', 'vx test')
  git('add', '-A')
  git('commit', '-qm', 'init')
  git('remote', 'add', 'origin', origin)
  return { origin, packages: [...names, 'p5'] }
}

async function cloneFixture(origin: string, tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `vx-agents-${tag}-`))
  const clone = Bun.spawnSync({ cmd: ['git', 'clone', '-q', origin, 'repo'], cwd: dir })
  expect(clone.exitCode).toBe(0)
  return path.join(dir, 'repo')
}

interface AgentProc {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  stdout(): string
  assignments(): number
  kill(): void
}

function spawnAgent(
  cwd: string,
  serveOrigin: string,
  session: string,
  capacity: number,
  token: string,
): AgentProc {
  const proc = Bun.spawn({
    cmd: [
      'bun',
      BIN,
      'agent',
      '--url',
      serveOrigin,
      '--token',
      token,
      '--session',
      session,
      '--capacity',
      String(capacity),
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  let out = ''
  void (async () => {
    for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
  })()
  let err = ''
  void (async () => {
    for await (const chunk of proc.stderr) err += new TextDecoder().decode(chunk)
  })()
  return {
    proc,
    stdout: () => out + err,
    assignments: () => (out.match(/▶ /g) ?? []).length,
    kill: () => proc.kill(9),
  }
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

/**
 * Poll the serve's `/v1/agents` capacity read until N remote agents have
 * REGISTERED — the agent banner prints before its WS hello lands, so a fixed
 * sleep is a race under load; the registry itself is the ground truth.
 */
async function untilRemoteAgents(
  serveOrigin: string,
  workspaceRoot: string,
  session: string,
  n: number,
  token: string,
): Promise<void> {
  const ws = captureWorkspaceIdentity(workspaceRoot).id
  const url =
    `${serveOrigin}/v1/agents?ws=${encodeURIComponent(ws)}` +
    `&session=${encodeURIComponent(session)}`
  const deadline = Date.now() + 15_000
  for (;;) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } }).catch(
      () => null,
    )
    if (res?.ok) {
      const body = (await res.json()) as { remoteAgents?: number }
      if ((body.remoteAgents ?? 0) >= n) return
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} registered agents`)
    await Bun.sleep(100)
  }
}

/** A capturing render sink (the submitter's terminal stand-in). */
function captureSink(): Logger & { text: () => string; completed: Map<string, string> } {
  let buf = ''
  const completed = new Map<string, string>()
  return {
    status(line: string) {
      buf += `${line}\n`
    },
    taskStdout(_node: TaskNode, chunk: string) {
      buf += chunk
    },
    taskStderr(_node: TaskNode, chunk: string) {
      buf += chunk
    },
    taskComplete(node: TaskNode, outcome: TaskOutcome) {
      completed.set(node.id, outcome.status)
    },
    text: () => buf,
    completed,
  }
}

describe('distributed execution — the real thing', () => {
  it(
    'two agents + submitter: placement, streaming, artifacts, materialization, warm rerun assigns nothing',
    async () => {
      const session = `e2e-${process.pid}-1`
      process.env['VX_AGENT_SESSION'] = session
      const platform = await bootPlatform()
      const fixture = await makeFixture(false)
      const agent1Root = await cloneFixture(fixture.origin, 'a1')
      const agent2Root = await cloneFixture(fixture.origin, 'a2')
      const a1 = spawnAgent(agent1Root, platform.origin, session, 2, platform.ciToken)
      const a2 = spawnAgent(agent2Root, platform.origin, session, 2, platform.ciToken)
      try {
        await until(() => a1.stdout().includes('vx agent: serve'), 15_000, 'agent 1 banner')
        await until(() => a2.stdout().includes('vx agent: serve'), 15_000, 'agent 2 banner')
        await untilRemoteAgents(platform.origin, fixture.origin, session, 2, platform.ciToken)

        const sink = captureSink()
        const backend = distributedBackend({
          origin: platform.origin,
          token: platform.ciToken,
          expectedAgents: 2,
          sink,
          warn: (l) => sink.status(l),
        })
        const result = await backend.run({ tasks: ['build'], cwd: fixture.origin, concurrency: 1 })

        // Aggregate verdict + every task terminal-success.
        expect(result.ok).toBe(true)
        expect(result.outcomes).toHaveLength(5)
        for (const o of result.outcomes) expect(o.status).toBe('success')

        // Placement: BOTH remote agents executed at least one task.
        expect(a1.assignments()).toBeGreaterThanOrEqual(1)
        expect(a2.assignments()).toBeGreaterThanOrEqual(1)

        // Streaming: every task's stdout marker reached the submitter's
        // renderer through the serve relay.
        for (const name of fixture.packages) {
          expect(sink.text()).toContain(`building-${name}`)
          expect(sink.completed.get(`${name}#build`)).toBe('success')
        }

        // Artifacts: one upload per cacheable task in the S3 store,
        // tenant-partitioned (an org-wide trusted ci token → the shared _org
        // segment under trusted).
        const stored = [...platform.s3.objects.keys()].filter(
          (k) => k.includes(`org/${platform.orgId}/ws/_org/trusted/`) && k.endsWith('.tar.zst'),
        )
        expect(stored).toHaveLength(5)

        // Materialization: the submitter's checkout has every declared
        // output, including tasks it never executed itself.
        for (const name of fixture.packages) {
          const outFile = path.join(fixture.origin, 'packages', name, 'out.txt')
          expect(await Bun.file(outFile).text()).toContain(`built-${name}`)
        }

        // The §6.3 payoff: a WARM resubmission probe-prunes everything on
        // the serve — ZERO new assignments reach any agent.
        const a1Before = a1.assignments()
        const a2Before = a2.assignments()
        const warmSink = captureSink()
        const warmBackend = distributedBackend({
          origin: platform.origin,
          token: platform.ciToken,
          expectedAgents: 2,
          sink: warmSink,
          warn: (l) => warmSink.status(l),
        })
        const warm = await warmBackend.run({
          tasks: ['build'],
          cwd: fixture.origin,
          concurrency: 1,
        })
        expect(warm.ok).toBe(true)
        expect(warm.outcomes).toHaveLength(5)
        for (const o of warm.outcomes) expect(o.status).toBe('cache-hit-remote')
        expect(a1.assignments()).toBe(a1Before)
        expect(a2.assignments()).toBe(a2Before)
      } finally {
        a1.kill()
        a2.kill()
        await platform.stop()
        await rm(fixture.origin, { recursive: true, force: true })
        await rm(path.dirname(agent1Root), { recursive: true, force: true })
        await rm(path.dirname(agent2Root), { recursive: true, force: true })
        delete process.env['VX_AGENT_SESSION']
      }
    },
    TIMEOUT,
  )

  it(
    'two CONCURRENT submissions share one session pool; neither is refused',
    async () => {
      const session = `e2e-${process.pid}-multi`
      process.env['VX_AGENT_SESSION'] = session
      const platform = await bootPlatform()
      const fixture = await makeFixture(true) // slow tasks so the two runs overlap
      const a1Root = await cloneFixture(fixture.origin, 'ma1')
      const a2Root = await cloneFixture(fixture.origin, 'ma2')
      // Two DISTINCT submitter checkouts (like two teammates) — same commit +
      // remote ⇒ same workspaceId + session, so they land in ONE session.
      const subARoot = await cloneFixture(fixture.origin, 'msubA')
      const subBRoot = await cloneFixture(fixture.origin, 'msubB')
      const a1 = spawnAgent(a1Root, platform.origin, session, 2, platform.ciToken)
      const a2 = spawnAgent(a2Root, platform.origin, session, 2, platform.ciToken)
      try {
        await until(() => a1.stdout().includes('vx agent: serve'), 15_000, 'agent 1 banner')
        await until(() => a2.stdout().includes('vx agent: serve'), 15_000, 'agent 2 banner')
        await untilRemoteAgents(platform.origin, fixture.origin, session, 2, platform.ciToken)

        // Two disjoint-scope submissions at the same commit + session, run
        // concurrently. Before the multi-run scheduler the second would get
        // "session … already has an active submission".
        const sinkA = captureSink()
        const sinkB = captureSink()
        const mk = (sink: ReturnType<typeof captureSink>) =>
          distributedBackend({
            origin: platform.origin,
            token: platform.ciToken,
            expectedAgents: 2,
            sink,
            warn: (l) => sink.status(l),
          })
        const [ra, rb] = await Promise.all([
          mk(sinkA).run({ tasks: ['p1#build', 'p2#build'], cwd: subARoot, concurrency: 1 }),
          mk(sinkB).run({ tasks: ['p3#build', 'p4#build'], cwd: subBRoot, concurrency: 1 }),
        ])

        expect(ra.ok).toBe(true)
        expect(rb.ok).toBe(true)
        for (const o of [...ra.outcomes, ...rb.outcomes]) expect(o.status).toBe('success')
        // The concurrency rejection must never surface on either submitter —
        // this is the multi-run capability under test (output materialization
        // itself is covered by the single-submission case above).
        expect(sinkA.text()).not.toContain('already has an active submission')
        expect(sinkB.text()).not.toContain('already has an active submission')
        // The shared pool actually did work for the two concurrent runs.
        expect(a1.assignments() + a2.assignments()).toBeGreaterThanOrEqual(1)
      } finally {
        a1.kill()
        a2.kill()
        await platform.stop()
        await rm(fixture.origin, { recursive: true, force: true })
        await rm(path.dirname(a1Root), { recursive: true, force: true })
        await rm(path.dirname(a2Root), { recursive: true, force: true })
        await rm(path.dirname(subARoot), { recursive: true, force: true })
        await rm(path.dirname(subBRoot), { recursive: true, force: true })
        delete process.env['VX_AGENT_SESSION']
      }
    },
    TIMEOUT,
  )

  it(
    'killing an agent mid-task reassigns its work and the run completes',
    async () => {
      const session = `e2e-${process.pid}-2`
      process.env['VX_AGENT_SESSION'] = session
      const platform = await bootPlatform()
      const fixture = await makeFixture(true)
      const agentRoot = await cloneFixture(fixture.origin, 'victim')
      const victim = spawnAgent(agentRoot, platform.origin, session, 4, platform.ciToken)
      try {
        await until(() => victim.stdout().includes('vx agent: serve'), 15_000, 'victim banner')
        await untilRemoteAgents(platform.origin, fixture.origin, session, 1, platform.ciToken)

        const sink = captureSink()
        const backend = distributedBackend({
          origin: platform.origin,
          token: platform.ciToken,
          expectedAgents: 1,
          sink,
          warn: (l) => sink.status(l),
        })
        const running = backend.run({
          tasks: ['p1#build'],
          cwd: fixture.origin,
          concurrency: 1,
        })

        // Wait for the victim to receive the (slow) assignment, then kill
        // it mid-task: the scheduler re-queues at the front and the
        // submitter's self-agent picks it up.
        await until(() => victim.assignments() >= 1, 20_000, 'victim assignment')
        victim.kill()

        const result = await running
        expect(result.ok).toBe(true)
        const p1 = result.outcomes.find((o) => o.taskId === 'p1#build')
        expect(p1?.status).toBe('success')
        expect(
          await Bun.file(path.join(fixture.origin, 'packages', 'p1', 'out.txt')).text(),
        ).toContain('built-p1')
      } finally {
        victim.kill()
        await platform.stop()
        await rm(fixture.origin, { recursive: true, force: true })
        await rm(path.dirname(agentRoot), { recursive: true, force: true })
        delete process.env['VX_AGENT_SESSION']
      }
    },
    TIMEOUT,
  )
})
