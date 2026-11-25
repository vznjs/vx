// From source (the npm launcher's fallback, a musl host) `bun <entry>` alone
// dropped the bin.ts shebang's flags: a local() worker's vx loaded the
// worktree's `.env` into its env and ran its bunfig preload.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { vxArgv } from '../src/local.js'

let dir = ''
afterEach(() => rm(dir, { recursive: true, force: true }))

it("a worker's vx from source starts Bun with the shebang's flags", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-dte-argv-'))
  await writeFile(path.join(dir, '.env'), 'VX_DTE_PROBE=from-dotenv\n')
  await writeFile(path.join(dir, 'pre.ts'), "console.log('PRELOAD')\n")
  await writeFile(path.join(dir, 'bunfig.toml'), 'preload = ["./pre.ts"]\n')
  await writeFile(
    path.join(dir, 'entry.ts'),
    "console.log(`probe=${process.env['VX_DTE_PROBE'] ?? 'unset'}`)\n",
  )
  const env = { ...process.env }
  delete env['VX_DTE_PROBE']
  const argv = vxArgv()
  const r = Bun.spawnSync({
    cmd: [...argv.slice(0, -1), path.join(dir, 'entry.ts')],
    cwd: dir,
    env,
  })
  expect(r.stdout.toString()).toBe('probe=unset\n')
})
