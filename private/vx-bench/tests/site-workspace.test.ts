// The workspace every runner is timed on. A runner that fetches anything
// during a run times the network, and in the per-PR gate's sandbox fails.

import { expect, it } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TURBO_FUTURE_FLAGS } from '@vzn/vx-conformance/turbo-flags'
import { workspace } from '../shape.js'
import pkg from '../package.json'
import {
  generate,
  gitInit,
  linkRivals,
  RIVAL_SPECS,
  RUNNER_ENV,
  rivalRuns,
} from '../site-workspace.js'

it('the rivals run at npm latest, never a pin', () => {
  expect(RIVAL_SPECS).toEqual(['turbo@latest', 'nx@latest', 'vite-plus@latest'])
  const deps: Record<string, string> = { ...pkg.devDependencies }
  expect(Object.keys(deps).filter((d) => ['turbo', 'nx', 'vite-plus'].includes(d))).toEqual([])
})

it('Turbo runs on the opt-ins conformance scores it on', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-site-ws-'))
  try {
    await generate(
      dir,
      2,
      workspace()
        .filter((p) => p.level === 1 && p.deps.length === 0)
        .slice(0, 2),
    )
    expect((await Bun.file(path.join(dir, 'turbo.json')).json()).futureFlags).toEqual(
      TURBO_FUTURE_FLAGS,
    )
    await linkRivals(dir)
    gitInit(dir)
    const r = Bun.spawnSync(rivalRuns(dir, 2).turbo.run, {
      cwd: dir,
      env: RUNNER_ENV,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })
    const out = r.stdout.toString() + r.stderr.toString()
    expect(r.exitCode, out).toBe(0)
    // A CI terminal colours the summary.
    expect(Bun.stripANSI(out)).toMatch(/Tasks: +10 successful, 10 total/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 90_000)

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

it("links each project's dependencies into its node_modules, where its build reads them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-site-ws-'))
  try {
    const all = workspace()
    const byName = new Map(all.map((p) => [p.name, p]))
    const p = all.find((q) => q.deps.length > 1)!
    await generate(dir, 2, [p, ...p.deps.map((d) => byName.get(d)!)])
    for (const d of p.deps)
      expect(realpathSync(path.join(dir, 'packages', p.dir, 'node_modules', d))).toBe(
        realpathSync(path.join(dir, 'packages', byName.get(d)!.dir)),
      )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
