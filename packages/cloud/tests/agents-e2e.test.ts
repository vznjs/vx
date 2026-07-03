// The real distributed-execution e2e (distributed-execution-2026-07 §11):
// one serve (token + artifact store), TWO `vx-cloud agent` subprocesses on
// separate `git clone`s of the fixture at the same commit, and a
// distribute submission from the fixture origin. Asserts placement across
// both agents, event streaming back to the submitter, artifact upload,
// output materialization on the submitter, the §6.3 payoff (a WARM rerun
// dispatches ZERO assignments), and mid-run agent-death reassignment.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Logger, TaskNode, TaskOutcome } from '@vzn/vx'
import { startServe } from '../src/cli/serve.js'
import { distributedBackend } from '../src/dist/submit.js'
import { serveInfoPath } from '../src/serve-info.js'

const TIMEOUT = 120_000
const TOKEN = 'agents-e2e-tok'
const BIN = path.join(import.meta.dir, '..', 'src', 'cli', 'bin.ts')

const ENV_KEYS = [
  'VX_CLOUD_SERVE_INFO',
  'VX_REMOTE_CACHE_URL',
  'VX_REMOTE_CACHE_TOKEN',
  'VX_CLOUD_AGENT',
  'VX_AGENT_SESSION',
  'VX_CLOUD_DISTRIBUTE',
]
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  process.env['VX_CLOUD_SERVE_INFO'] = path.join(
    tmpdir(),
    `vx-serveinfo-agents-${process.pid}.json`,
  )
})

afterAll(async () => {
  await rm(serveInfoPath(), { force: true })
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
): AgentProc {
  const proc = Bun.spawn({
    cmd: [
      'bun',
      BIN,
      'agent',
      '--url',
      serveOrigin,
      '--token',
      TOKEN,
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
      const ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-agents-serve-'))
      const server = await startServe({ root: ingestDir, ingestDir, token: TOKEN })
      const fixture = await makeFixture(false)
      const agent1Root = await cloneFixture(fixture.origin, 'a1')
      const agent2Root = await cloneFixture(fixture.origin, 'a2')
      const a1 = spawnAgent(agent1Root, server.origin, session, 2)
      const a2 = spawnAgent(agent2Root, server.origin, session, 2)
      try {
        await until(() => a1.stdout().includes('vx agent: serve'), 15_000, 'agent 1 banner')
        await until(() => a2.stdout().includes('vx agent: serve'), 15_000, 'agent 2 banner')
        // The banner prints before the WS registers; give the hellos a beat.
        await Bun.sleep(800)

        const sink = captureSink()
        const backend = distributedBackend({
          origin: server.origin,
          token: TOKEN,
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

        // Artifacts: one upload per cacheable task in the serve store. The
        // token maps to the default/trusted scope.
        const stored = await readdir(path.join(ingestDir, 'artifacts', 'default', 'trusted'))
        expect(stored.filter((f) => f.endsWith('.tar.zst'))).toHaveLength(5)

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
          origin: server.origin,
          token: TOKEN,
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
        await server.stop()
        await rm(fixture.origin, { recursive: true, force: true })
        await rm(path.dirname(agent1Root), { recursive: true, force: true })
        await rm(path.dirname(agent2Root), { recursive: true, force: true })
        await rm(ingestDir, { recursive: true, force: true })
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
      const ingestDir = await mkdtemp(path.join(tmpdir(), 'vx-agents-serve2-'))
      const server = await startServe({ root: ingestDir, ingestDir, token: TOKEN })
      const fixture = await makeFixture(true)
      const agentRoot = await cloneFixture(fixture.origin, 'victim')
      const victim = spawnAgent(agentRoot, server.origin, session, 4)
      try {
        await until(() => victim.stdout().includes('vx agent: serve'), 15_000, 'victim banner')
        await Bun.sleep(800)

        const sink = captureSink()
        const backend = distributedBackend({
          origin: server.origin,
          token: TOKEN,
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
        await server.stop()
        await rm(fixture.origin, { recursive: true, force: true })
        await rm(path.dirname(agentRoot), { recursive: true, force: true })
        await rm(ingestDir, { recursive: true, force: true })
        delete process.env['VX_AGENT_SESSION']
      }
    },
    TIMEOUT,
  )
})
