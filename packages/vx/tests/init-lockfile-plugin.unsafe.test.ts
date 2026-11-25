// `vx init` in a JS workspace declares the `@vzn/vx-lockfile` plugin its
// lockfile calls for. `.unsafe`: the fixture links @vzn/vx-lockfile from
// this repo, a read outside this project a sandboxed shard may not make.
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { BIN, vx as spawnVx } from './helpers/vx.js'

const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function tmp(prefix: string): Promise<string> {
  // Real path: macOS's /tmp is a link, and a child's cwd is resolved.
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), prefix)))
  roots.push(root)
  expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
  return root
}

// The `next:` line names the runner that started vx; none here.
const vx = (cwd: string, args: string[]) =>
  spawnVx(cwd, args, { bin: BIN, env: { npm_config_user_agent: undefined } })

describe('vx init in a JS workspace', () => {
  // It declared no plugin, so the first `^build` a user wrote was refused at
  // `vx lock` ("^build needs project edges") until they found
  // @vzn/vx-lockfile themselves.
  it('declares the lockfile plugin its lockfile calls for, and ^build locks', async () => {
    const root = await tmp('vx-init-js-')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    for (const [name, deps] of [
      ['lib', {}],
      ['app', { lib: 'workspace:*' }],
    ] as const) {
      await mkdir(path.join(root, 'packages', name), { recursive: true })
      await writeFile(
        path.join(root, 'packages', name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', dependencies: deps }),
      )
    }
    // Bun's install cache is under the home, which a sandboxed shard may not write.
    const installed = Bun.spawnSync({
      cmd: [process.execPath, 'install'],
      cwd: root,
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(root, '.bun-cache') },
    })
    expect(installed.exitCode).toBe(0)
    // A source checkout installs nothing: the package as a release installs it.
    await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    await symlink(
      path.resolve(import.meta.dir, '..', '..', 'vx-lockfile'),
      path.join(root, 'node_modules', '@vzn', 'vx-lockfile'),
    )
    const r = await vx(root, ['init'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect(await readFile(path.join(root, '.vx', 'workspace.ts'), 'utf8')).toBe(
      "import type { WorkspaceConfig } from '@vzn/vx/config'\nimport { bun } from '@vzn/vx-lockfile'\n\nexport default { plugins: [bun()] } satisfies WorkspaceConfig\n",
    )
    for (const name of ['lib', 'app'])
      await writeFile(
        path.join(root, 'packages', name, 'vx.config.ts'),
        "import type { ProjectConfig } from '@vzn/vx/config'\n\nexport default { tasks: { build: { exec: { command: 'true' }, dependsOn: ['^build'], inputs: { files: ['package.json'] } } } } satisfies ProjectConfig\n",
      )
    const lock = await vx(root, ['lock'])
    expect([lock.code, lock.err]).toEqual([0, ''])
    const dry = await vx(root, ['run', 'build', '--filter', 'app', '--dry', '--format', 'json'])
    expect(dry.out).toContain('lib#build')
  })

  // A pnpm workspace not installed yet has no lockfile: init installed with
  // npm (a package-lock.json in a pnpm workspace) and declared no plugin.
  // A single package got none either, though init's own install writes its
  // lockfile: a dependency bump then moved no key.
  it.each([
    ['a pnpm workspace', 'pnpm', 'pnpm'],
    ['a `workspaces` workspace', 'npm', 'workspaces'],
    ['a single package', 'npm', 'single'],
  ])('declares the plugin of %s with no lockfile yet: %s', async (_, plugin, shape) => {
    const root = await tmp('vx-init-unlocked-')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        private: true,
        ...(shape === 'workspaces' ? { workspaces: ['packages/*'] } : {}),
      }),
    )
    if (shape === 'pnpm')
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    await symlink(
      path.resolve(import.meta.dir, '..', '..', 'vx-lockfile'),
      path.join(root, 'node_modules', '@vzn', 'vx-lockfile'),
    )
    const r = await vx(root, ['init', '--dry', '--format', 'json'])
    expect([r.code, r.err]).toEqual([0, ''])
    const files = (JSON.parse(r.out) as { files: { path: string; contents: string }[] }).files
    expect(files.find((f) => f.path === '.vx/workspace.ts')?.contents).toContain(
      `plugins: [${plugin}()]`,
    )
  })

  // Init run before the install, then again once bun.lock exists: the kept
  // workspace file declared no plugin, and init said nothing, so ^build
  // stayed without edges.
  it('a kept workspace file with no lockfile plugin is named, with the one to add', async () => {
    const root = await tmp('vx-init-kept-plugin-')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await mkdir(path.join(root, '.vx'))
    await writeFile(
      path.join(root, '.vx', 'workspace.ts'),
      'export default { plugins: [] } // mine\n',
    )
    await writeFile(
      path.join(root, 'bun.lock'),
      '{"lockfileVersion":1,"workspaces":{"":{"name":"r"}},"packages":{}}\n',
    )
    await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
    await symlink(
      path.resolve(import.meta.dir, '..', '..', 'vx-lockfile'),
      path.join(root, 'node_modules', '@vzn', 'vx-lockfile'),
    )
    const note =
      ".vx/workspace.ts declares no @vzn/vx-lockfile plugin: beside bun.lock, add bun() from '@vzn/vx-lockfile' so a dependency change re-runs its tasks and ^build has project edges, or run vx init --force"
    const r = await vx(root, ['init', '--dry', '--format', 'json'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect((JSON.parse(r.out) as { notes: string[] }).notes).toEqual([note])
    // CONTROL: a workspace file that declares it gets no note.
    await writeFile(
      path.join(root, '.vx', 'workspace.ts'),
      "import { bun } from '@vzn/vx-lockfile'\nexport default { plugins: [bun()] }\n",
    )
    const ok = await vx(root, ['init', '--dry', '--format', 'json'])
    expect((JSON.parse(ok.out) as { notes: string[] }).notes).toEqual([])
    // Not installed yet, with npm: "in a npm workspace".
    await rm(path.join(root, 'bun.lock'))
    await writeFile(path.join(root, '.vx', 'workspace.ts'), 'export default { plugins: [] }\n')
    const npm = await vx(root, ['init', '--dry', '--format', 'json'])
    expect((JSON.parse(npm.out) as { notes: string[] }).notes).toEqual([
      ".vx/workspace.ts declares no @vzn/vx-lockfile plugin: in an npm workspace, add npm() from '@vzn/vx-lockfile' so a dependency change re-runs its tasks and ^build has project edges, or run vx init --force",
    ])
  })
})
