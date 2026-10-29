// What a history server answers is read at the boundary: a number no
// server folds (1e309 parses to Infinity) was kept as a forecast in the
// local cache, and every later run of that cache failed in `schedule`.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { HistoryServer } from '../src/history-server.js'
import { NAMED } from './issuer.js'

/** A server answering every hash asked with `timing`, as raw JSON text; `answered` marks a query answered. */
function serve(timing: string, answered: string): Bun.Server<undefined> {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      if (new URL(req.url).pathname === '/v1/capabilities')
        return Response.json({ maxUploadTimings: 100, maxQueryHashes: 100 })
      const { hashes } = (await req.json()) as { hashes: string[] }
      const rows = hashes.map((h) => `${JSON.stringify(h)}:${timing}`)
      await writeFile(answered, '')
      return new Response(`{"timings":{${rows.join(',')}}}`, {
        headers: { 'content-type': 'application/json' },
      })
    },
  })
}

describe("a history server's answer", () => {
  it('keeps only the numbers a server folds: whole ms, finite cores, a byte count', async () => {
    const answers: Record<string, string> = {
      ok: '{"durationMs":40,"cores":1.5,"rssBytes":1000}',
      inf: '{"durationMs":1e309}',
      huge: '{"durationMs":1e308}',
      frac: '{"durationMs":0.5}',
      neg: '{"durationMs":-1}',
      badNeeds: '{"durationMs":7,"cores":1e309,"rssBytes":-5}',
    }
    const body = `{"timings":{${Object.entries(answers)
      .map(([h, t]) => `"${h}":${t}`)
      .join(',')}}}`
    const fake = (async (u: string) =>
      new URL(u).pathname === '/v1/capabilities'
        ? Response.json({ maxUploadTimings: 9, maxQueryHashes: 9 })
        : new Response(body)) as unknown as typeof fetch
    const client = new HistoryServer('https://h.example', NAMED, {}, fake)
    expect(await client.query(['refs/heads/main'], Object.keys(answers))).toEqual(
      new Map([
        ['ok', { durationMs: 40, cores: 1.5, rssBytes: 1000 }],
        ['badNeeds', { durationMs: 7 }],
      ]),
    )
  })

  describe('in a run', () => {
    let root: string
    let srv: Bun.Server<undefined>
    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'vx-history-answers-'))
      srv = serve('{"durationMs":1e309}', path.join(root, 'answered'))
      await mkdir(path.join(root, 'pkg'), { recursive: true })
      // `a` outlasts the query's answer, so it lands in the run; `b` fails,
      // so it has no timing of its own and the next run reads the server's.
      await writeFile(
        path.join(root, 'pkg', 'vx.config.mjs'),
        `export default { tasks: {
  a: { exec: { command: 'until [ -e ../answered ]; do sleep 0.05; done; sleep 0.2' }, inputs: { files: [] } },
  b: { exec: { command: 'exit 1' }, dependsOn: ['a'], inputs: { files: [] } },
} }
`,
      )
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
          `export default { plugins: [vxHistory({ url: ${JSON.stringify(srv.url.href.replace(/\/$/, ''))}, ...${JSON.stringify(NAMED)} })] }\n`,
      )
      // A branch with a commit: a run that reads no ref asks the server nothing.
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
    })
    afterAll(async () => {
      await srv.stop(true)
      await rm(root, { recursive: true, force: true })
    })

    it('never fails a later run', async () => {
      const statuses: string[][] = []
      for (let i = 0; i < 2; i++) {
        const r = await run({ cwd: root, tasks: ['b'], handleSignals: false })
        statuses.push(r.outcomes.map((o) => o.status))
      }
      expect(statuses).toEqual([
        ['success', 'failed'],
        ['success', 'failed'],
      ])
    }, 30_000)
  })
})
