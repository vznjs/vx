// `vx info` counts tasks from the lock, as a run reads them, and never
// evaluates a config: broken configs are `vx lock`'s to report. With no
// lock it still answers, with `projects lock: no` and no tasks.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { packagesSource, PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function workspace(): Promise<string> {
  // Canonical: macOS's tmpdir is a symlink, and vx names the real path.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-info-lock-')))
  roots.push(root)
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  const scripts = pluginSource(
    'scripts-plugin',
    `{
      async project(config, ctx) {
        config.tasks ??= {}
        const { scripts } = await Bun.file(ctx.dir + '/package.json').json()
        for (const [name, command] of Object.entries(scripts ?? {})) {
          config.tasks[name] ??= { exec: { command } }
        }
      },
    }`,
  )
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${packagesSource()}, ${scripts}] }\n`,
  )
  const bare = path.join(root, 'packages', 'bare')
  await mkdir(bare, { recursive: true })
  await writeFile(
    path.join(bare, 'package.json'),
    JSON.stringify({ name: 'bare', scripts: { build: 'true', test: 'true' } }),
  )
  const app = path.join(root, 'packages', 'app')
  await mkdir(app, { recursive: true })
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(
    path.join(app, 'vx.config.mjs'),
    "export default { tasks: { lint: { exec: { command: 'true' } } } }\n",
  )
  return root
}

function vx(root: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false', NO_COLOR: '1' },
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('vx info reads the lock', () => {
  it('with no lock it answers: no lock, no tasks, nothing evaluated', async () => {
    const root = await workspace()
    // A config that would throw if evaluated: info must not run it.
    await writeFile(
      path.join(root, 'packages', 'app', 'vx.config.mjs'),
      "throw new Error('evaluated')\n",
    )
    const r = vx(root, 'info', '--format', 'json')
    const facts = JSON.parse(r.out) as Record<string, unknown>
    expect({
      code: r.code,
      err: r.err,
      lockfile: facts['lockfile'],
      tasks: facts['tasks'],
    }).toEqual({ code: 0, err: '', lockfile: false, tasks: 0 })
    expect(facts).not.toHaveProperty('configErrors')
    expect(vx(root, 'info').out).toMatch(/^  projects lock +no$/m)
  })

  it('counts the locked configs and the plugin stage as vx run does', async () => {
    const root = await workspace()
    expect(vx(root, 'lock').code).toBe(0)
    // Edited after the lock: info reads the lock, not the file.
    await writeFile(
      path.join(root, 'packages', 'app', 'vx.config.mjs'),
      "throw new Error('evaluated')\n",
    )
    const r = vx(root, 'info', '--format', 'json')
    const facts = JSON.parse(r.out) as Record<string, unknown>
    // app's lint plus its default build, and bare's build and test.
    expect({
      code: r.code,
      err: r.err,
      lockfile: facts['lockfile'],
      tasks: facts['tasks'],
    }).toEqual({ code: 0, err: '', lockfile: true, tasks: 4 })
  })

  // A lock a run refuses read "projects lock yes" with no task, and exit 0:
  // the one fact a reader needed, why, was swallowed (2026-10-28).
  it('a lock a run would refuse is said, with the refusal', async () => {
    const root = await workspace()
    await writeFile(path.join(root, '.vx', 'projects.lock.json'), '{')
    const r = vx(root, 'info', '--format', 'json')
    const facts = JSON.parse(r.out) as Record<string, unknown>
    const said = '.vx/projects.lock.json is not valid JSON — re-run `vx lock` or delete it'
    expect([r.code, facts['lockfile'], facts['lockError']]).toEqual([0, true, said])
    expect(vx(root, 'info').out).toContain(`  projects lock     refused: ${said}`)
    // CONTROL: a lock a run reads has no error.
    expect(vx(root, 'lock').code).toBe(0)
    expect(JSON.parse(vx(root, 'info', '--format', 'json').out)['lockError']).toBe(null)
  })
})
