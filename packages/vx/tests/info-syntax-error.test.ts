// `vx info` names a config that did not load once, workspace-relative. A
// syntax error's message carries `:line:col` after the absolute path, which
// the prefix strip missed, so the row named the file twice. And a broken
// config leaves every other project's count as a run would see it, plugin
// `project` stage included (X-26).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function workspace(prefix: string): Promise<string> {
  // Canonical: macOS's tmpdir is a symlink, and vx names the real path.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
  roots.push(root)
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  return root
}

function infoJson(root: string): { code: number; err: string; facts: Record<string, unknown> } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'info', '--format', 'json'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, err: r.stderr.toString(), facts: JSON.parse(r.stdout.toString()) }
}

describe('vx info — a config with a syntax error', () => {
  it('names the file once, then the line and column', async () => {
    const root = await workspace('vx-info-syntax-')
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(path.join(dir, 'vx.config.mjs'), 'export default {\n')
    const { code, err, facts } = infoJson(root)
    expect({ code, err }).toEqual({ code: 0, err: '' })
    const errors = facts['configErrors']
    expect(errors).toEqual([
      { path: 'packages/a/vx.config.mjs', message: expect.stringMatching(/^\d+:\d+: \S/) },
    ])
    expect(JSON.stringify(errors)).not.toContain(root)
  })

  it('counts the other projects as vx run does and names the error vx run stops on', async () => {
    const root = await workspace('vx-info-staged-')
    const scripts = pluginSource(
      'scripts-plugin',
      `{
        project(config, ctx) {
          config.tasks ??= {}
          for (const [name, command] of Object.entries(ctx.packageJson.scripts ?? {})) {
            config.tasks[name] ??= { exec: { command } }
          }
        },
      }`,
    )
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${scripts}] }\n`,
    )
    const bare = path.join(root, 'packages', 'bare')
    await mkdir(bare, { recursive: true })
    await writeFile(
      path.join(bare, 'package.json'),
      JSON.stringify({ name: 'bare', scripts: { build: 'true', test: 'true', lint: 'true' } }),
    )
    const app = path.join(root, 'packages', 'app')
    await mkdir(app, { recursive: true })
    await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(app, 'vx.config.mjs'), 'export default {{{\n')

    const run = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'build', '--all'],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const prefix = `vx: Project config ${path.join(app, 'vx.config.mjs')}:`
    const stops = run.stderr.toString().trim()
    expect(stops.startsWith(prefix)).toBe(true)

    const { code, err, facts } = infoJson(root)
    expect({ code, err, tasks: facts['tasks'], errors: facts['configErrors'] }).toEqual({
      code: 0,
      err: '',
      tasks: 3,
      errors: [{ path: 'packages/app/vx.config.mjs', message: stops.slice(prefix.length) }],
    })
  })
})
