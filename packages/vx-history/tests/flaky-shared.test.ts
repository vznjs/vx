// The flaky record a history server keeps across CI machines: a task its
// query answer names flaky gets the one retry a known flake gets, and a
// run's upload carries each cached task's outcome for that record.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { NAMED } from './issuer.js'

describe('a flaky record on the history server', () => {
  let root: string
  let srv: Bun.Server<undefined>
  let flaky = true
  const uploads: { outcomes?: { hash: string; key: string; outcome: string }[] }[] = []
  const token = Bun.env.VX_HISTORY_TOKEN
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-history-flaky-'))
    srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const at = new URL(req.url).pathname
        const body = (await req.json()) as {
          hashes?: string[]
          outcomes?: { hash: string; key: string; outcome: string }[]
        }
        if (at === '/v1/timings/upload') {
          uploads.push(body)
          return new Response(null, { status: 204 })
        }
        await writeFile(path.join(root, 'answered'), '')
        return Response.json({ timings: {}, flaky: flaky ? body.hashes : [] })
      },
    })
    await mkdir(path.join(root, 'pkg'), { recursive: true })
    // `a` outlasts the query's answer; `t` and `u` fail once per `once` file,
    // outside its inputs, so its key never moves.
    await writeFile(
      path.join(root, 'pkg', 'vx.config.mjs'),
      `export default { tasks: {
  a: { exec: { command: 'until [ -e ../answered ]; do sleep 0.05; done' }, inputs: { files: [] } },
  t: {
    exec: { command: 'if [ -e ../once-t ]; then rm ../once-t; exit 1; fi' },
    dependsOn: ['a'], inputs: { files: [] }, outputs: { files: [] }, cache: true,
  },
  u: {
    exec: { command: 'if [ -e ../once-u ]; then rm ../once-u; exit 1; fi' },
    dependsOn: ['a'], inputs: { files: [] }, outputs: { files: [] }, cache: true,
  },
  broken: { exec: { command: 'exit 1' }, inputs: { files: [] } },
  behind: {
    exec: { command: 'true' },
    dependsOn: ['broken'], inputs: { files: [] }, outputs: { files: [] }, cache: true,
  },
  uncached: { exec: { command: 'exit 1' }, inputs: { files: [] }, cache: false },
} }
`,
    )
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
        `export default { plugins: [vxHistory({ url: ${JSON.stringify(srv.url.href.replace(/\/$/, ''))}, ...${JSON.stringify(NAMED)} })] }\n`,
    )
    for (const cmd of [
      ['git', 'init', '-q', '-b', 'main'],
      [
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'i',
      ],
    ])
      Bun.spawnSync({ cmd, cwd: root })
    // A token makes the run write: the fake server checks none.
    Bun.env.VX_HISTORY_TOKEN = 'token'
  })
  afterAll(async () => {
    if (token === undefined) delete Bun.env.VX_HISTORY_TOKEN
    else Bun.env.VX_HISTORY_TOKEN = token
    await srv.stop(true)
    await rm(root, { recursive: true, force: true })
  })

  const runOnce = async (task: string) => {
    await rm(path.join(root, 'answered'), { force: true })
    await writeFile(path.join(root, `once-${task}`), '')
    const r = await run({
      cwd: root,
      tasks: [task],
      cacheFlags: { force: true },
      handleSignals: false,
    })
    return r.outcomes.find((o) => o.node.taskName === task)!
  }

  it('retries a task the server names flaky, and reports it flaky', async () => {
    const t = await runOnce('t')
    expect(t.status).toBe('success')
    expect(t.attempts?.count).toBe(2)
    const sent = uploads.at(-1)?.outcomes ?? []
    expect(sent.map((o) => `${o.key} ${o.outcome}`)).toEqual([`${t.hash} flaky`])
  }, 30_000)

  it('fails a task the server does not name, and reports the failure', async () => {
    flaky = false
    const t = await runOnce('u')
    expect(t.status).toBe('failed')
    expect(t.attempts).toBeUndefined()
    expect((uploads.at(-1)?.outcomes ?? []).map((o) => o.outcome)).toEqual(['fail'])
  }, 30_000)

  // A pass behind a failed dependency built on bytes its key never named:
  // sent as a pass, a later healthy failure on the key read as a flake, and
  // every fresh machine retried a real failure for thirty days.
  it('sends nothing for a task that ran behind a failure, nor one with cache: false', async () => {
    flaky = false
    const before = uploads.length
    const r = await run({
      cwd: root,
      tasks: ['behind', 'uncached'],
      continueMode: 'always',
      cacheFlags: { force: true },
      handleSignals: false,
    })
    const statuses = r.outcomes.map((o) => `${o.node.taskName} ${o.status}`).sort()
    expect(statuses).toEqual(['behind success', 'broken failed', 'uncached failed'])
    expect(uploads.slice(before).flatMap((u) => u.outcomes ?? [])).toEqual([])
  }, 30_000)
})
