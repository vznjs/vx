// The canary (`check.sandbox-canary`) runs unsandboxed beside the macOS
// shards on one agent. It wrote a store per fixture to the home's `~/.vx`,
// and the home guard of every shard on that agent failed for it.
// `.unsafe`: it drives the sandbox, which cannot nest.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox canary home test')

it.skipIf(!available)(
  'the canary writes nothing to the home’s shared store',
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'vx-canary-home-'))
    try {
      const { VX_CACHE_DIR: _, ...env } = process.env
      const r = Bun.spawnSync(
        [process.execPath, path.join(import.meta.dir, 'helpers', 'sandbox-canary.ts'), '1'],
        { env: { ...env, HOME: home }, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(r.stdout.toString()).toContain('[canary] SUMMARY iterations=1')
      expect(await readdir(path.join(home, '.vx')).catch(() => [])).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  },
  60_000,
)
