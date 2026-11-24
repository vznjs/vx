// A run that writes only the remote (`--cache-policy=local:,remote:w`), whose
// remote already held the key, printed no cache row and `—` for the task's
// outputs: the task was in the saved bucket, which only a local write shows,
// and its bytes were read off a local entry that was never written
// (hardening, 2026-11-23).
import { rm } from 'node:fs/promises'
import { expect, it } from 'bun:test'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'printf 12345 > out.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] }, cache: true,
      },
    },
  }
`

const WRITE_ONLY = { localRead: false, localWrite: false, remoteRead: false, remoteWrite: true }

async function runWith(held: boolean) {
  const fixture = await makeWorkspace('vx-remote-held-row-')
  try {
    await addProject(fixture.root, 'a', { files: { 'src/in.txt': 'a' }, config: CONFIG })
    const puts: string[] = []
    const layer: RemoteCacheLayer = {
      has: async () => (held ? { size: 1 } : null),
      hasMany: async (hashes) => new Map(held ? hashes.map((h) => [h, { size: 1 }]) : []),
      get: async () => null,
      put: async (hash) => void puts.push(hash),
    }
    const result = await run({
      cwd: fixture.root,
      tasks: ['build'],
      log: silentLogger(fixture),
      remoteCache: layer,
      cache: WRITE_ONLY,
      handleSignals: false,
    })
    const lines = fixture.log.map((l) => Bun.stripANSI(l))
    // The meter row, then its legend.
    const at = lines.findIndex((l) => /^\s*cache\s/.test(l))
    const row = at < 0 ? undefined : lines[at + 1]
    return {
      ok: result.ok,
      puts: puts.length,
      row: row?.trim().replace(/\s+/g, ' '),
      outputBytes: result.outcomes[0]?.cache?.outputBytes,
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
}

it(
  'a remote-only write whose key the remote held shows its cache row and outputs',
  async () => {
    expect(await runWith(true)).toEqual({ ok: true, puts: 0, row: 'remote 1↑', outputBytes: 5 })
  },
  TIMEOUT,
)

it(
  'a remote-only write that uploads shows the same, with the bytes sent',
  async () => {
    const sent = await runWith(false)
    expect({ ...sent, row: sent.row?.replace(/ \d+ B$/, ' <bytes>') }).toEqual({
      ok: true,
      puts: 1,
      row: 'remote 1↑ <bytes>',
      outputBytes: 5,
    })
  },
  TIMEOUT,
)
