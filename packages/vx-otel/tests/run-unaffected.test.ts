// A collector that is down, refuses with a 500, or never answers must
// leave a real `vx run` as it would be without it: the task runs, its
// output lands, the run is green, the exit is bounded by core's flush
// deadline, and the failure is said, not thrown (F stream, B-100).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '@vzn/vx'

const OTEL_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

let root = ''
let server: ReturnType<typeof Bun.serve> | undefined
const held: Array<() => void> = []
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-otel-run-'))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', workspaces: ['pkg'] }),
  )
  await mkdir(path.join(root, 'pkg'), { recursive: true })
  await writeFile(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'pkg' }))
  await writeFile(
    path.join(root, 'pkg', 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'echo built > out.txt' } } } }`,
  )
  const git = (...a: string[]) => Bun.spawnSync({ cmd: ['git', ...a], cwd: root })
  git('init', '-q')
  git(
    '-c',
    'user.email=t@vx.local',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  )
  process.env['VX_TEARDOWN_TIMEOUT_MS'] = '1500'
})
afterEach(async () => {
  for (const release of held.splice(0)) release()
  await server?.stop(true)
  server = undefined
  delete process.env['VX_TEARDOWN_TIMEOUT_MS']
  await rm(root, { recursive: true, force: true })
})

/** A collector answering each request as `mode` says; its endpoint. */
function collector(mode: '500' | 'hang'): string {
  server = Bun.serve({
    port: 0,
    fetch: () =>
      mode === '500'
        ? new Response('collector broke', { status: 500 })
        : new Promise<Response>((resolve) => held.push(() => resolve(new Response('late')))),
  })
  return `http://127.0.0.1:${server.port}`
}

/** A port nothing listens on. */
async function down(): Promise<string> {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = s.port
  await s.stop(true)
  return `http://127.0.0.1:${port}`
}

async function runWith(endpoint: string) {
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { otel } from ${JSON.stringify(OTEL_INDEX)}\n` +
      `export default { plugins: [otel({ endpoint: ${JSON.stringify(endpoint)}, timeoutMs: 60000 })] }\n`,
  )
  const said: string[] = []
  const log = {
    runStart: () => undefined,
    taskStart: () => undefined,
    taskStdout: () => undefined,
    taskStderr: () => undefined,
    taskComplete: () => undefined,
    runStatus: () => undefined,
    runEnd: () => undefined,
    status: (l: string) => said.push(l),
  }
  const t0 = Date.now()
  const r = await run({ cwd: root, projects: ['pkg'], tasks: ['build'], log, handleSignals: false })
  return {
    ok: r.ok,
    statuses: r.outcomes.map((o) => o.status),
    out: await Bun.file(path.join(root, 'pkg', 'out.txt')).text(),
    said,
    ms: Date.now() - t0,
  }
}

const fail = (signal: string, why: string) =>
  `[vx-otel] export failed for http://127.0.0.1:PORT/v1/${signal}: ${why}`

describe('a run whose collector fails', () => {
  const cases = [
    {
      name: 'is down',
      endpoint: () => down(),
      said: ['traces', 'metrics'].map((s) =>
        fail(s, 'Unable to connect. Is the computer able to access the url?'),
      ),
    },
    {
      name: 'answers 500',
      endpoint: () => collector('500'),
      said: ['traces', 'metrics'].map((s) => fail(s, 'HTTP 500: collector broke')),
    },
    {
      // The plugin's own timeout is a minute: core's flush deadline ends it.
      name: 'never answers',
      endpoint: () => collector('hang'),
      said: [
        '[vx] telemetry flush timed out after 1500ms; buffered records lost',
        ...['traces', 'metrics'].map((s) => fail(s, 'The operation was aborted.')),
      ],
    },
  ]
  for (const c of cases) {
    it(`${c.name}: the run is green, bounded, and says so once a signal`, async () => {
      const r = await runWith(await c.endpoint())
      expect([r.ok, r.statuses, r.out]).toEqual([true, ['success'], 'built\n'])
      expect(
        r.said
          .filter((l) => /vx-otel|telemetry/.test(l))
          .map((l) => l.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:PORT')),
      ).toEqual(c.said)
      expect(r.ms).toBeLessThan(5_000)
    }, 20_000)
  }
})
