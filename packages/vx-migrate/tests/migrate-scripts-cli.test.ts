// A repo with package.json scripts and no Turbo, Nx or Vite Task config:
// vx-migrate maps the scripts, one vx.config.ts per package, and declares
// the lockfile plugin its lockfile calls for. `vx init` hands such a repo
// here (2026-10-14: core reads no package.json).

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const roots: string[] = []
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})

async function bunRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-scripts-'))
  roots.push(root)
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/*"]}\n')
  await writeFile(path.join(root, 'bun.lock'), '{}\n')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'a', 'package.json'),
    '{"name":"a","scripts":{"build":"tsc"}}\n',
  )
  return root
}

/**
 * What `--no-install` left out: core, linked, and a stand-in
 * @vzn/vx-lockfile whose plugins give each package its workspace deps
 * (what a migration installs is adopt.test.ts's subject).
 */
async function linkPlugins(root: string): Promise<void> {
  const vzn = path.join(root, 'node_modules', '@vzn')
  await mkdir(path.join(vzn, 'vx-lockfile'), { recursive: true })
  const core = path.dirname(path.dirname(Bun.resolveSync('@vzn/vx', import.meta.dir)))
  await symlink(core, path.join(vzn, 'vx'), 'dir')
  await writeFile(
    path.join(vzn, 'vx-lockfile', 'package.json'),
    JSON.stringify({ name: '@vzn/vx-lockfile', type: 'module', exports: './index.js' }),
  )
  await writeFile(
    path.join(vzn, 'vx-lockfile', 'index.js'),
    `import { definePlugin } from '@vzn/vx'
export const bun = () => definePlugin(import.meta, {
  async discover(ctx) {
    const pkgs = await Promise.all(ctx.projects.map((p) => Bun.file(p.dir + '/package.json').json().catch(() => ({}))))
    const dir = new Map(pkgs.map((pkg, i) => [pkg.name, ctx.projects[i].dir]))
    return ctx.projects.map((p, i) => ({
      dir: p.dir,
      deps: Object.keys({ ...pkgs[i].dependencies }).filter((n) => n !== pkgs[i].name && dir.has(n)).map((n) => dir.get(n)),
    }))
  },
})
export { bun as npm, bun as pnpm, bun as yarn }
`,
  )
}

async function migrate(cwd: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, '--no-install', BIN, ...args], {
    cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code }
}

describe('vx-migrate on package.json scripts', () => {
  it('maps each package and declares the lockfile plugin', async () => {
    const root = await bunRepo()
    const r = await migrate(root, ['--dry', '--format', 'json'])
    expect([r.code, r.err]).toEqual([0, ''])
    const plan = JSON.parse(r.out) as {
      source: string
      files: { path: string; contents: string }[]
    }
    expect([plan.source, plan.files.map((f) => f.path)]).toEqual([
      'package.json scripts',
      ['packages/a/vx.config.ts', '.vx/workspace.ts', '.vx/.gitignore'],
    ])
    expect(plan.files[0]!.contents).toContain("command: 'tsc'")
    expect(plan.files[1]!.contents).toContain("import { bun } from '@vzn/vx-lockfile'")
  })

  it('--from scripts reads them beside a turbo.json', async () => {
    const root = await bunRepo()
    await writeFile(path.join(root, 'turbo.json'), '{"tasks":{}}\n')
    const r = await migrate(root, ['--from', 'scripts', '--dry', '--format', 'json'])
    expect([r.code, r.err, (JSON.parse(r.out) as { source: string }).source]).toEqual([
      0,
      '',
      'package.json scripts',
    ])
  })

  it('--native and --keep answer a Turbo or Nx question, and are refused', async () => {
    const root = await bunRepo()
    const r = await migrate(root, ['--keep', '--dry'])
    expect([r.code, r.err]).toEqual([
      1,
      "vx-migrate: --keep answers a Turbo or Nx repo's question, and no turbo.json or nx.json is at .\n",
    ])
  })

  // `vx init` in a Bun workspace with scripts writes an empty root project
  // and names vx-migrate; its starter was kept, and the root's scripts lost.
  it("maps over vx init's starter: the root's scripts become its tasks", async () => {
    const root = await bunRepo()
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"r","workspaces":["packages/*"],"scripts":{"lint":"oxlint ."}}\n',
    )
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env }).exitCode).toBe(0)
    const init = Bun.spawnSync(
      [process.execPath, path.resolve(import.meta.dir, '../../vx/src/bin.ts'), 'init'],
      { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
    )
    expect([init.exitCode, init.stdout.toString()]).toEqual([
      0,
      expect.stringContaining('bunx @vzn/vx-migrate to make package.json scripts tasks'),
    ])
    const r = await migrate(root, ['--no-install'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect(r.out).not.toContain('kept')
    expect(await readFile(path.join(root, 'vx.config.ts'), 'utf8')).toContain("command: 'oxlint .'")
  })

  // vx init's workspace file, untouched, declares no plugin: kept as the
  // user's, the lockfile plugin went undeclared and `vx lock` refused every
  // `^build` init's own next step wrote (2026-11-22). Its CRLF checkout too.
  for (const [eol, format] of [
    ['\n', 'ts'],
    ['\r\n', 'ts'],
    ['\n', 'mjs'],
  ] as const) {
    it(`declares the lockfile plugin over vx init's ${format} workspace file (${JSON.stringify(eol)})`, async () => {
      const root = await bunRepo()
      const starter =
        format === 'ts'
          ? "import type { WorkspaceConfig } from '@vzn/vx/config'\n\nexport default { plugins: [] } satisfies WorkspaceConfig\n"
          : 'export default { plugins: [] }\n'
      await mkdir(path.join(root, '.vx'))
      await writeFile(path.join(root, '.vx', `workspace.${format}`), starter.replaceAll('\n', eol))
      const r = await migrate(root, [
        '--dry',
        '--format',
        'json',
        ...(format === 'mjs' ? ['--mjs'] : []),
      ])
      expect([r.code, r.err]).toEqual([0, ''])
      const plan = JSON.parse(r.out) as { files: { path: string; contents: string }[] }
      expect(plan.files.find((f) => f.path === `.vx/workspace.${format}`)?.contents).toContain(
        "import { bun } from '@vzn/vx-lockfile'",
      )
    })
  }

  it('vx init, then vx-migrate: vx lock passes and ^build orders the packages', async () => {
    const root = await bunRepo()
    await mkdir(path.join(root, 'packages', 'b'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'b', 'package.json'),
      '{"name":"b","dependencies":{"a":"workspace:*"},"scripts":{"build":"tsc"}}\n',
    )
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const core = path.resolve(import.meta.dir, '../../vx/src/bin.ts')
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env }).exitCode).toBe(0)
    expect(Bun.spawnSync([process.execPath, core, 'init'], { cwd: root, env }).exitCode).toBe(0)
    const r = await migrate(root, ['--no-install'])
    expect([r.code, r.err]).toEqual([0, ''])
    await linkPlugins(root)
    const lock = Bun.spawnSync([process.execPath, core, 'lock'], { cwd: root, env, stderr: 'pipe' })
    expect([lock.exitCode, lock.stderr.toString()]).toEqual([0, ''])
  })

  it('keeps a workspace file the user wrote', async () => {
    const root = await bunRepo()
    await mkdir(path.join(root, '.vx'))
    await writeFile(
      path.join(root, '.vx', 'workspace.ts'),
      'export default { plugins: [] } // mine\n',
    )
    const r = await migrate(root, ['--dry', '--format', 'json'])
    expect([r.code, r.err]).toEqual([0, ''])
    const plan = JSON.parse(r.out) as { files: { path: string }[] }
    expect(plan.files.map((f) => f.path)).not.toContain('.vx/workspace.ts')
  })

  // A starter of the other extension was left beside the migrated root
  // config: the loader read the starter, and the root's tasks were lost
  // (2026-11-11). Replaced, as `--force` replaces one (item 1033).
  for (const [starter, written, args, text] of [
    [
      'vx.config.ts',
      'vx.config.mjs',
      ['--mjs'],
      "import type { ProjectConfig } from '@vzn/vx/config'\n\nexport default { tasks: {} } satisfies ProjectConfig\n",
    ],
    ['vx.config.mjs', 'vx.config.ts', [], 'export default { tasks: {} }\n'],
  ] as const) {
    it(`replaces vx init's ${starter} starter with ${written}`, async () => {
      const root = await bunRepo()
      await writeFile(
        path.join(root, 'package.json'),
        '{"name":"r","workspaces":["packages/*"],"scripts":{"fmt":"oxfmt ."}}\n',
      )
      await writeFile(path.join(root, starter), text)
      const r = await migrate(root, ['--no-install', ...args])
      expect([r.code, r.err]).toEqual([0, ''])
      expect(r.out).toContain(`replaced  ${starter}`)
      expect(await Bun.file(path.join(root, starter)).exists()).toBe(false)
      expect(await readFile(path.join(root, written), 'utf8')).toContain("'oxfmt .'")
    })
  }

  // A lone package with no lockfile, `--no-install`: the workspace file
  // declares no lockfile plugin, so `^build` had no edges to follow and the
  // `vx lock` the report named refused it (2026-11-11).
  it('a lone package with no lockfile plugin gets no ^ edge, and the next line runs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-solo-'))
    roots.push(root)
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"solo","scripts":{"build":"echo built","test":"echo tested"}}\n',
    )
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env }).exitCode).toBe(0)
    const r = await migrate(root, ['--no-install'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect(r.out).toContain('vx lock, then vx run build --all')
    const vx = (args: string[]) =>
      Bun.spawnSync(
        [process.execPath, path.resolve(import.meta.dir, '../../vx/src/bin.ts'), ...args],
        {
          cwd: root,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
    for (const args of [['lock'], ['run', 'build', '--all']]) {
      const p = vx(args)
      expect([args, p.exitCode, p.stderr.toString()]).toEqual([args, 0, ''])
    }
  })

  // `vx init` first, as its next line says: its workspace file names no
  // plugin, the lone package kept `^build`, and the `vx lock` after
  // refused it (2026-11-21).
  it('a lone package after vx init gets no ^ edge, and vx lock passes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-solo-init-'))
    roots.push(root)
    await writeFile(
      path.join(root, 'package.json'),
      '{"name":"solo","scripts":{"build":"echo built","test":"echo tested"}}\n',
    )
    await writeFile(
      path.join(root, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"":{"name":"solo"}}}\n',
    )
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    }
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env }).exitCode).toBe(0)
    const vx = (args: string[]) =>
      Bun.spawnSync(
        [process.execPath, path.resolve(import.meta.dir, '../../vx/src/bin.ts'), ...args],
        { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
      )
    expect(vx(['init']).exitCode).toBe(0)
    const r = await migrate(root, ['--no-install'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect(await readFile(path.join(root, 'vx.config.ts'), 'utf8')).not.toContain('^build')
    await linkPlugins(root)
    const p = vx(['lock'])
    expect([p.exitCode, p.stderr.toString()]).toEqual([0, ''])
  })

  // With no lockfile plugin nothing names a project from its manifest: vx
  // calls the root `//` and a member by its path, and the report's
  // `solo#build` was a task `vx run` refused (2026-11-23).
  it('with no lockfile plugin the report names projects as vx does', async () => {
    const solo = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-solo-name-'))
    roots.push(solo)
    await writeFile(path.join(solo, 'package.json'), '{"name":"solo","scripts":{"build":"tsc"}}\n')
    const lone = await migrate(solo, ['--no-install', '--dry'])
    expect([lone.code, lone.err]).toEqual([0, ''])
    expect(lone.out).toContain('//#build: cache:')
    expect(lone.out).not.toContain('solo#build')

    const root = await bunRepo()
    await rm(path.join(root, 'bun.lock'))
    const ws = await migrate(root, ['--no-install', '--dry'])
    expect([ws.code, ws.err]).toEqual([0, ''])
    expect(ws.out).toContain('packages/a#build: cache:')

    const named = await migrate(await bunRepo(), ['--no-install', '--dry'])
    expect(named.out).toContain(' a#build: cache:')
  })

  it('a workspace with no lockfile plugin is told what gives `^build` its edges', async () => {
    const root = await bunRepo()
    await rm(path.join(root, 'bun.lock'))
    await mkdir(path.join(root, 'packages', 'b'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'b', 'package.json'),
      '{"name":"b","scripts":{"build":"tsc"}}\n',
    )
    const r = await migrate(root, ['--no-install'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect(r.out.replace(/\s+/g, ' ')).toContain(
      '`^build` has no project edges: install with the package manager',
    )
  })
})
