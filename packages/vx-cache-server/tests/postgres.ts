// A throwaway Postgres for the tests: initdb into a temp directory and a
// server on a free loopback port, no Unix socket. Its binaries come from
// PATH or Debian's /usr/lib/postgresql/<n>/bin (GitHub's Ubuntu runners
// carry them). Postgres refuses to run as root: as root it runs as nobody.

import { spawn } from 'node:child_process'
import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** The directory holding `initdb` and `postgres`, or undefined. */
export function postgresBin(): string | undefined {
  const onPath = Bun.which('initdb')
  if (onPath !== null) return path.dirname(onPath)
  const debian = '/usr/lib/postgresql'
  if (!existsSync(debian)) return undefined
  const newest = readdirSync(debian)
    .filter((v) => existsSync(path.join(debian, v, 'bin', 'initdb')))
    .sort((a, b) => Number(b) - Number(a))[0]
  return newest === undefined ? undefined : path.join(debian, newest, 'bin')
}

export async function startPostgres(bin: string): Promise<{ url: string; stop(): Promise<void> }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-cache-pg-'))
  const root = process.getuid?.() === 0
  const as = root ? { uid: 65_534, gid: 65_534 } : {}
  if (root) chownSync(dir, 65_534, 65_534)
  const data = path.join(dir, 'data')
  const run = (cmd: string, args: string[]) =>
    spawn(path.join(bin, cmd), args, { ...as, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  const said = (p: ReturnType<typeof run>) => {
    let out = ''
    p.stdout?.on('data', (d) => (out += d))
    p.stderr?.on('data', (d) => (out += d))
    return () => out
  }
  const init = run('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-sync'])
  const initSaid = said(init)
  const code = await new Promise<number | null>((resolve) => init.on('exit', resolve))
  if (code !== 0) throw new Error(`initdb failed: ${initSaid()}`)
  const port = 20_000 + Math.floor(Math.random() * 40_000)
  const server = run('postgres', [
    '-D',
    data,
    '-p',
    String(port),
    '-c',
    'listen_addresses=127.0.0.1',
    '-c',
    'unix_socket_directories=',
    '-c',
    'fsync=off',
    '-c',
    'dynamic_shared_memory_type=mmap',
  ])
  const serverSaid = said(server)
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`
  const deadline = Date.now() + 20_000
  for (;;) {
    if (server.exitCode !== null) throw new Error(`postgres exited: ${serverSaid()}`)
    try {
      const sql = new Bun.SQL(url)
      await sql`SELECT 1`
      await sql.close()
      break
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`postgres did not start: ${String(err)}`)
      await Bun.sleep(100)
    }
  }
  return {
    url,
    async stop() {
      server.kill('SIGINT')
      await new Promise((resolve) => server.on('exit', resolve))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
