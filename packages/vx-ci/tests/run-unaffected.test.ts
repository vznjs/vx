// A Checks API that refuses (no `checks: write`), rate-limits, or a run with
// no token must leave a real `vx run` as it would be without the plugin: the
// task runs, its output and the job summary land, the run is green, and the
// reason is said once (F stream, B-100).
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '@vzn/vx'

const GITHUB_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const ENV = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_API_URL'] as const

let root = ''
let server: ReturnType<typeof Bun.serve> | undefined
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {}
beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  root = await mkdtemp(path.join(tmpdir(), 'vx-ci-run-'))
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
    'i',
  )
})
afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  await server?.stop(true)
  server = undefined
  await rm(root, { recursive: true, force: true })
})

/** An API answering every request with `status` and `body`; its URL. */
function api(status: number, body: string): string {
  server = Bun.serve({ port: 0, fetch: () => new Response(body, { status }) })
  return `http://127.0.0.1:${server.port}`
}

async function runWith(
  env: Partial<Record<(typeof ENV)[number], string>>,
): Promise<Record<string, unknown>> {
  for (const k of ENV) {
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  const summary = path.join(root, 'summary.md')
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { github } from ${JSON.stringify(GITHUB_INDEX)}\n` +
      `export default { plugins: [github({ summaryFile: ${JSON.stringify(summary)}, checks: true })] }\n`,
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
  const r = await run({ cwd: root, projects: ['pkg'], tasks: ['build'], log, handleSignals: false })
  return {
    ok: r.ok,
    statuses: r.outcomes.map((o) => o.status),
    out: await Bun.file(path.join(root, 'pkg', 'out.txt')).text(),
    summary: (await Bun.file(summary).exists()) ? 'written' : 'absent',
    said: said.filter((l) => l.startsWith('vx-ci:')),
  }
}

const job = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc' }

const ran = { ok: true, statuses: ['success'], out: 'built\n', summary: 'written' }

describe('a run whose Checks API fails', () => {
  it('without checks: write is green, summarised, and names the permission', async () => {
    const r = await runWith({
      ...job,
      GITHUB_API_URL: api(403, 'Resource not accessible by integration'),
    })
    expect(r).toEqual({
      ...ran,
      said: [
        'vx-ci: check-run POST failed (403) — does the workflow grant `permissions: checks: write`?: Resource not accessible by integration',
      ],
    })
  })

  it('rate-limited is green, summarised, and names the rate limit', async () => {
    const r = await runWith({
      ...job,
      GITHUB_API_URL: api(403, 'You have exceeded a secondary rate limit.'),
    })
    expect(r).toEqual({
      ...ran,
      said: [
        'vx-ci: check-run POST failed (403) — rate-limited by GitHub; this run has no check: You have exceeded a secondary rate limit.',
      ],
    })
  })

  it('with no token is green, summarised, and says the check was skipped', async () => {
    expect(await runWith({ GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 'abc' })).toEqual({
      ...ran,
      said: [
        'vx-ci: checks requested but GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_SHA are not all set — no check-run will be created',
      ],
    })
  })
})
