// A sandboxed task with no network grant reaches no service on the host:
// not a listener on the host's loopback (a dev database, a cloud metadata
// proxy) and not a unix socket outside the workspace (the Docker daemon's,
// a path a read of `/var/run` can name). Probed held on Linux (L-46);
// nothing pinned it, so a change to how SRT is driven could open either.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const available = await sandboxAvailable('sandbox host services test')
let root: string | undefined
const stops: (() => void)[] = []

afterAll(async () => {
  for (const s of stops) s()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe.skipIf(!available)('a sandboxed task and the host’s services', () => {
  it('reaches neither a loopback listener nor a unix socket, which the host reaches', async () => {
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-hostsvc-')))
    const tcp = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('TCP') })
    stops.push(() => void tcp.stop(true))
    const sock = path.join(root, 'h.sock')
    const unix = Bun.listen({
      unix: sock,
      // Written, not ended: a FIN beside the bytes let the client's `close`
      // win the race and read as no answer.
      socket: { open: (s) => void s.write('UNIX'), data() {} },
    })
    stops.push(() => unix.stop(true))
    const probe = (what: string): string =>
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(what)}`
    const tcpProbe = `const r = await fetch('http://127.0.0.1:${tcp.port}').then((r) => r.text(), () => 'no tcp'); console.log(r)`
    const unixProbe = `const r = await new Promise((ok) => Bun.connect({ unix: ${JSON.stringify(sock)}, socket: { data: (_s, d) => ok(String(d)), error: () => ok('no unix'), connectError: () => ok('no unix'), close: () => ok('no unix') } }).catch(() => ok('no unix'))); console.log(r); process.exit(0)`
    // The host reaches both: the probes, not the listeners, are what fail inside.
    // Spawned async: a sync spawn holds this process's loop, and the
    // listeners it serves would never answer.
    const host = async (code: string): Promise<string> => {
      const p = Bun.spawn({ cmd: [process.execPath, '-e', code], stdout: 'pipe' })
      return (await new Response(p.stdout).text()).trim()
    }
    expect([await host(tcpProbe), await host(unixProbe)]).toEqual(['TCP', 'UNIX'])

    const ws = path.join(root, 'ws')
    await mkdir(path.join(ws, 'packages', 'a'), { recursive: true })
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await writeFile(path.join(ws, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(
      path.join(ws, 'packages', 'a', 'vx.config.mjs'),
      `export default { tasks: {
  tcp: { exec: { command: ${JSON.stringify(probe(tcpProbe))}, sandbox: { allow: { read: ['.'] } } } },
  unix: { exec: { command: ${JSON.stringify(probe(unixProbe))}, sandbox: { allow: { read: ['.'] } } } },
} }
`,
    )
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws }).exitCode).toBe(0)
    const r = Bun.spawn({
      cmd: [process.execPath, BIN, 'run', 'a#tcp', 'a#unix', '--output-logs', 'full', '--continue'],
      cwd: ws,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const text = (await new Response(r.stdout).text()) + (await new Response(r.stderr).text())
    // A set: where the refused connect is a violation (seatbelt), the task
    // fails and the failure recap prints its last line again.
    const said = [
      ...new Set(
        text
          .split('\n')
          .map((l) => l.replace(/^.*?│\s?/, '').trim())
          .filter((l) => /^(TCP|UNIX|no tcp|no unix)$/.test(l)),
      ),
    ].sort()
    expect(said, text).toEqual(['no tcp', 'no unix'])
  }, 30_000)
})
