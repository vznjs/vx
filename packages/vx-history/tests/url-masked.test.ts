// A history server's url may carry `user:pass@`: the run's warnings
// printed it whole, and the password reached the CI log. Only config
// refusals masked it.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { NAMED } from './issuer.js'
import { HistoryServer } from '../src/history-server.js'

const SECRET = 'Sup3rSecretPw'

/** `vx run build --all` in a fresh workspace whose vxHistory names `url`: its vx-history lines. */
async function warned(url: string): Promise<string[]> {
  const other = await mkdtemp(path.join(tmpdir(), 'vx-history-masked-'))
  try {
    await mkdir(path.join(other, 'pkg'), { recursive: true })
    await writeFile(
      path.join(other, 'pkg', 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: [] } } } }\n",
    )
    await Bun.write(
      path.join(other, '.vx/workspace.mjs'),
      `import { vxHistory } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'index.ts'))}\n` +
        `export default { plugins: [vxHistory({ url: ${JSON.stringify(url)}, ...${JSON.stringify(NAMED)} })] }\n`,
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q', '-b', 'main'], cwd: other })
    Bun.spawnSync({
      cmd: [
        'git',
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'x',
      ],
      cwd: other,
    })
    // A token, so the run uploads: with none it reads only.
    const env = { ...Bun.env, NO_COLOR: '1', HOME: path.join(other, 'home'), VX_HISTORY_TOKEN: 't' }
    const bin = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')
    Bun.spawnSync({ cmd: [process.execPath, bin, 'lock'], cwd: other, env })
    const cli = Bun.spawn({
      cmd: [process.execPath, bin, 'run', 'build', '--all'],
      cwd: other,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ])
    expect(code).toBe(0)
    return `${out}${err}`.split('\n').filter((l) => l.includes('vx-history'))
  } finally {
    await rm(other, { recursive: true, force: true })
  }
}

it("a server's password is masked in the warnings of one that does not answer", async () => {
  const gone = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = gone.port
  await gone.stop(true)
  const said = await warned(`http://alice:${SECRET}@127.0.0.1:${port}`)
  expect(said.join('\n')).not.toContain(SECRET)
  expect(said.map((l) => l.split(': ')[1])).toEqual([
    `the timings of the history server at http://***@127.0.0.1:${port} were not applied`,
    `the timings were not sent to the history server at http://***@127.0.0.1:${port}`,
  ])
}, 30_000)

// It said "no answer" of a server that answered 503 each time it was asked.
it('a teardown that ran out while the server refused names the status, the password masked', async () => {
  const busy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      new URL(req.url).pathname === '/v1/timings/query'
        ? Response.json({ timings: {} })
        : new Response('busy', { status: 503 }),
  })
  try {
    const said = await warned(`http://alice:${SECRET}@127.0.0.1:${busy.port}`)
    expect(said).toEqual([
      `[vx] vx-history: the timings of 1 task were not sent to the history server at http://***@127.0.0.1:${busy.port}: it answered HTTP 503, and the 2000 ms a teardown waits ran out before it was asked again`,
    ])
  } finally {
    await busy.stop(true)
  }
}, 30_000)

it("a redirect's target is said with the password masked", async () => {
  const moved = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(null, { status: 307, headers: { location: '/elsewhere' } }),
  })
  try {
    const client = new HistoryServer(`http://alice:${SECRET}@127.0.0.1:${moved.port}`, NAMED, {})
    const err = await client.query(['refs/heads/main'], ['a1']).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(String(err)).not.toContain(SECRET)
    expect(String(err)).toContain(`to http://***@127.0.0.1:${moved.port}/elsewhere`)
  } finally {
    await moved.stop(true)
  }
})
