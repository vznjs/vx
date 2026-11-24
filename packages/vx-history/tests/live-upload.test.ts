// A run's timings reach the history server while it goes: a long run's
// finished tasks are known to the next run's planner before this one ends,
// and teardown's bound covers only the remainder. Each task goes once: the
// server folds every report, and one sent twice would move its row twice.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { NAMED } from './issuer.js'

const QUICK = 50

describe('timings sent while the run goes', () => {
  let root: string
  let srv: Bun.Server<undefined>
  let status = 204
  let refused = 0
  // Set, a run's upload over `max` is refused for its size, and its part
  // number `failAt` (from 1) is refused once.
  let split: { max: number; failAt: number; parts: number } | undefined
  const uploads: { timings: { hash: string }[] }[] = []
  const token = Bun.env.VX_HISTORY_TOKEN
  const ci = Bun.env.CI
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-history-live-'))
    srv = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const at = new URL(req.url).pathname
        const body = (await req.json()) as { timings: { hash: string }[] }
        if (at !== '/v1/timings/upload') return Response.json({ timings: {}, flaky: [] })
        if (split !== undefined) {
          if (body.timings.length > split.max)
            return new Response('too many', {
              status: 413,
              headers: { 'vx-max-upload-timings': String(split.max) },
            })
          if (++split.parts === split.failAt) return new Response('bad part', { status: 400 })
        }
        if (status !== 204) {
          refused++
          return new Response('down', { status })
        }
        uploads.push(body)
        await writeFile(path.join(root, 'uploaded'), '')
        return new Response(null, { status: 204 })
      },
    })
    await mkdir(path.join(root, 'pkg'), { recursive: true })
    // `gate` ends only once an upload landed: a run that sends only at its
    // end never finishes it.
    const quick = Array.from(
      { length: QUICK },
      (_, i) => `  q${i}: { exec: { command: 'true' }, inputs: { files: [] } },`,
    )
    await writeFile(
      path.join(root, 'pkg', 'vx.config.mjs'),
      `export default { tasks: {
${quick.join('\n')}
  gate: { exec: { command: 'until [ -e ../uploaded ]; do sleep 0.05; done' }, inputs: { files: [] } },
  after: { exec: { command: 'true' }, dependsOn: ['gate'], inputs: { files: [] } },
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
      ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'].concat([
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'i',
      ]),
    ])
      Bun.spawnSync({ cmd, cwd: root })
    // A token on CI makes the run write: the fake server checks none.
    Bun.env.VX_HISTORY_TOKEN = 'token'
    Bun.env.CI = 'true'
  })
  afterAll(async () => {
    if (token === undefined) delete Bun.env.VX_HISTORY_TOKEN
    else Bun.env.VX_HISTORY_TOKEN = token
    if (ci === undefined) delete Bun.env.CI
    else Bun.env.CI = ci
    await srv.stop(true)
    await rm(root, { recursive: true, force: true })
  })

  const runAll = async () => {
    await rm(path.join(root, 'uploaded'), { force: true })
    uploads.length = 0
    return run({
      cwd: root,
      tasks: [...Array.from({ length: QUICK }, (_, i) => `q${i}`), 'after'],
      concurrency: 4,
      handleSignals: false,
    })
  }

  it('sends each finished task once, the first batch before the run ends', async () => {
    status = 204
    const r = await runAll()
    expect(r.outcomes.every((o) => o.status === 'success')).toBe(true)
    // The gate ended, so a batch went mid-run; `gate` and `after` came later.
    expect(uploads.length).toBeGreaterThanOrEqual(2)
    expect(uploads[0]!.timings.length).toBeGreaterThanOrEqual(QUICK)
    const hashes = uploads.flatMap((u) => u.timings.map((t) => t.hash))
    expect(new Set(hashes).size).toBe(hashes.length)
    expect(hashes.length).toBe(QUICK + 2)
  }, 30_000)

  // A server down mid-run is asked again once, at the end, with everything
  // it missed: one warning, nothing lost, nothing twice.
  it('holds a failed batch for the run end', async () => {
    status = 503
    refused = 0
    const pending = runAll()
    // The first batch fails its three tries (1 s, then 2 s apart).
    await Bun.sleep(4_500)
    status = 204
    // Nothing landed mid-run, so `gate` waits for the file: written here.
    await writeFile(path.join(root, 'uploaded'), '')
    const r = await pending
    expect(r.outcomes.every((o) => o.status === 'success')).toBe(true)
    expect(refused).toBe(3)
    expect(uploads.length).toBe(1)
    const hashes = uploads.flatMap((u) => u.timings.map((t) => t.hash))
    expect(new Set(hashes).size).toBe(hashes.length)
    expect(hashes.length).toBe(QUICK + 2)
  }, 30_000)

  // A split upload whose later part failed held the whole batch, and the
  // run's last upload sent the parts the server had folded again: their
  // rows moved twice.
  it('sends again only the parts a failed split upload did not land', async () => {
    status = 204
    split = { max: 10, failAt: 2, parts: 0 }
    try {
      const r = await runAll()
      expect(r.outcomes.every((o) => o.status === 'success')).toBe(true)
    } finally {
      split = undefined
    }
    const hashes = uploads.flatMap((u) => u.timings.map((t) => t.hash))
    expect([hashes.length, new Set(hashes).size]).toEqual([QUICK + 2, QUICK + 2])
  }, 30_000)

  // A token refused mid-run (a GitLab id_token past its exp) turned the
  // server off, and the run's last upload then returned unsent: the
  // timings were lost and nothing said so.
  it('says a token refused mid-run', async () => {
    status = 401
    refused = 0
    const said: string[] = []
    const write = { out: process.stdout.write, err: process.stderr.write }
    const hear = (chunk: unknown, ...rest: unknown[]): boolean => {
      said.push(String(chunk))
      const done = rest.find((r) => typeof r === 'function') as (() => void) | undefined
      done?.()
      return true
    }
    process.stdout.write = hear as typeof process.stdout.write
    process.stderr.write = hear as typeof process.stderr.write
    try {
      const pending = runAll()
      for (let i = 0; i < 200 && refused === 0; i++) await Bun.sleep(25)
      await writeFile(path.join(root, 'uploaded'), '')
      const r = await pending
      expect(r.outcomes.every((o) => o.status === 'success')).toBe(true)
    } finally {
      process.stdout.write = write.out
      process.stderr.write = write.err
    }
    // A run under vx (FORCE_COLOR) colours the `[vx]` prefix apart from the rest.
    const plain = said
      .join('')
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    expect(plain.match(/\[vx\] vx-history: [^\n]*the token was refused/g)?.length).toBe(1)
  }, 30_000)
})
