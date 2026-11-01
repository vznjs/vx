// The workspace every runner is timed on. A runner that fetches anything
// during a run times the network, and in the per-PR gate's sandbox fails.

import { expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { workspace } from '../shape.js'
import { generate, gitInit, linkRivals, RUNNER_ENV, rivalRuns } from '../site-workspace.js'

it('Vite Task installs nothing before a run, from a fresh home', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-site-ws-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'vx-site-home-'))
  try {
    await generate(
      dir,
      2,
      workspace()
        .filter((p) => p.level === 1 && p.deps.length === 0)
        .slice(0, 2),
    )
    await linkRivals(dir)
    gitInit(dir)
    const r = Bun.spawnSync(rivalRuns(dir, 2)['vite-task'].run, {
      cwd: dir,
      env: { ...RUNNER_ENV, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
    expect(r.exitCode, r.stdout.toString() + r.stderr.toString()).toBe(0)
    // An install lands in the home's data directory: `package_manager/bun`.
    expect(await readdir(home, { recursive: true })).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}, 90_000)
