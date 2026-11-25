// `vx init` outside a Turbo or Nx repo writes the workspace file and one
// empty root project, then the lock; a Turbo or Nx repo is handed to
// @vzn/vx-migrate (2026-10-20). A source checkout installs nothing:
// `initInstalls` is the plan a release runs.

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { verbHelpText } from '../src/cli/help.js'
import { initInstalls, notServed } from '../src/cli/init.js'
import * as ui from '../src/ui/index.js'
import { VERSION } from '../src/version.js'
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
const vx = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
  spawnVx(cwd, args, { bin: BIN, env: { npm_config_user_agent: undefined, ...extra } })

// Type-only: Bun erases the import, so the files load with nothing
// installed, and a user's tsc checks them against config.ts alone, never
// core's Bun-only sources (J-94).
const WORKSPACE =
  "import type { WorkspaceConfig } from '@vzn/vx/config'\n\nexport default { plugins: [] } satisfies WorkspaceConfig\n"
const PROJECT =
  "import type { ProjectConfig } from '@vzn/vx/config'\n\nexport default { tasks: {} } satisfies ProjectConfig\n"

// A moon workspace got the empty starter with no word: its moon.yml tasks
// read as migrated, though vx reads no moon config.
describe('vx init in a moon workspace', () => {
  it('says moon tasks are not migrated', async () => {
    const root = await tmp('vx-init-moon-')
    await mkdir(path.join(root, '.moon'))
    await writeFile(path.join(root, '.moon', 'workspace.yml'), 'projects:\n  - "packages/*"\n')
    const r = await vx(root, ['init', '--dry', '--format', 'json'])
    expect(r.code).toBe(0)
    expect((JSON.parse(r.out) as { notes: string[] }).notes).toEqual([
      "moon's tasks (.moon/ and each moon.yml) are not migrated: vx reads no moon config, so declare each task in a vx.config",
    ])
  })
})

describe('vx init with no package.json', () => {
  it('writes the workspace file and an empty root project, then the lock', async () => {
    const root = await tmp('vx-init-bare-')
    const r = await vx(root, ['init'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect([
      await readFile(path.join(root, '.vx', 'workspace.ts'), 'utf8'),
      await readFile(path.join(root, 'vx.config.ts'), 'utf8'),
      existsSync(path.join(root, '.vx', '.gitignore')),
      existsSync(path.join(root, '.vx', 'projects.lock')),
      existsSync(path.join(root, 'package.json')),
    ]).toEqual([WORKSPACE, PROJECT, true, true, false])
    expect(r.out).toBe(
      ui.render(
        [
          ui.report(`vx init ${VERSION}`, [
            ['from', 'no turbo.json or nx.json'],
            ['files', '.vx/workspace.ts', 'vx.config.ts', '.vx/.gitignore', '.vx/.gitattributes'],
            ['lock', '1 project config → .vx/projects.lock, .vx/dependencies.lock'],
            null,
            ['next', 'declare a task in vx.config.ts, then vx lock && vx run <task>'],
          ]),
        ],
        { enabled: false },
      ),
    )
    // The written workspace runs: the root is the one project, `//`.
    const show = await vx(root, ['show', '--format', 'json'])
    expect([show.code, (JSON.parse(show.out) as { name: string }[]).map((p) => p.name)]).toEqual([
      0,
      ['//'],
    ])
  })

  // vx-migrate settled other tools' files, init alone did not: prettier
  // --check failed on the locks, tsc compiled the config, biome checked them.
  it("settles prettier's, tsc's and biome's files, as vx-migrate does", async () => {
    const root = await tmp('vx-init-tools-')
    await writeFile(path.join(root, '.prettierignore'), 'dist\n')
    await writeFile(path.join(root, 'biome.json'), '{}\n')
    await writeFile(
      path.join(root, 'tsconfig.json'),
      '{ "compilerOptions": { "outDir": "dist" }, "exclude": ["node_modules"] }\n',
    )
    const r = await vx(root, ['init'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect([
      await readFile(path.join(root, '.prettierignore'), 'utf8'),
      JSON.parse(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).exclude,
    ]).toEqual([
      'dist\n\n# vx: what vx lock and runs write\n.vx/cache\n.vx/tmp\n.vx/projects.lock\n.vx/dependencies.lock\nvx.lock.json\n',
      ['vx.config.ts', 'node_modules'],
    ])
    expect(r.out).toContain('added the config to "exclude" in tsconfig.json')
    expect(r.out).not.toContain('add "vx.config.ts" to "exclude"')
    expect(r.out).toContain("biome checks vx's locks")
  })

  // A `.vx/` line hid the workspace file init wrote: the first clone had no
  // workspace, and init said nothing, where vx-migrate names it.
  it('names the written files .gitignore drops', async () => {
    const root = await tmp('vx-init-ignored-')
    await writeFile(path.join(root, '.gitignore'), '.vx/\n')
    const r = await vx(root, ['init', '--dry', '--format', 'json'])
    expect((JSON.parse(r.out) as { notes: string[] }).notes).toEqual([
      '.gitignore drops 3 files this would write (.vx/workspace.ts, .vx/.gitignore, .vx/.gitattributes): stop ignoring .vx/ (a ! line cannot re-include a file inside an ignored directory), or commit them with git add -f',
    ])
  })

  it('--dry --mjs writes nothing and prints the .mjs files', async () => {
    const root = await tmp('vx-init-bare-dry-')
    const r = await vx(root, ['init', '--dry', '--mjs'])
    expect([r.code, r.err, existsSync(path.join(root, '.vx'))]).toEqual([0, '', false])
    expect(r.out).toContain('── .vx/workspace.mjs ──\nexport default { plugins: [] }\n\n')
    expect(r.out).toContain('── vx.config.mjs ──\nexport default { tasks: {} }\n\n')
    expect(r.out).toContain(
      '  dry run   nothing written\n' +
        '  files     .vx/workspace.mjs\n' +
        '            vx.config.mjs\n' +
        '            .vx/.gitignore\n' +
        '            .vx/.gitattributes\n',
    )
  })

  // The run ends with `vx lock`, which writes these too: --dry named none.
  it('--dry names the files the lock writes', async () => {
    const root = await tmp('vx-init-bare-dry-lock-')
    const lockRow = async (env: Record<string, string>): Promise<string> => {
      const r = await vx(root, ['init', '--dry'], env)
      expect([r.code, r.err, existsSync(path.join(root, '.vx'))]).toEqual([0, '', false])
      return r.out.slice(r.out.indexOf('  lock '), r.out.indexOf('\n\n', r.out.indexOf('  lock ')))
    }
    expect(await lockRow({ VX_LOCK_REVIEW_FILES: 'true' })).toBe(
      '  lock      .vx/projects.lock\n' +
        '            .vx/dependencies.lock\n' +
        '            vx.lock.json beside each vx.config',
    )
    expect(await lockRow({ VX_LOCK_REVIEW_FILES: 'false' })).toBe(
      '  lock      .vx/projects.lock\n            .vx/dependencies.lock',
    )
    // A kept workspace file's own setting is the lock's.
    await mkdir(path.join(root, '.vx'))
    await writeFile(
      path.join(root, '.vx', 'workspace.mjs'),
      'export default { lock: { reviewFiles: false } }\n',
    )
    const r = await vx(root, ['init', '--dry'])
    expect(r.out).toContain('  lock      .vx/projects.lock\n            .vx/dependencies.lock\n\n')
  })

  it('keeps the files already here, and --force replaces them', async () => {
    const root = await tmp('vx-init-bare-kept-')
    const mine = 'export default { tasks: { hi: { exec: { command: "echo hi" } } } }\n'
    await writeFile(path.join(root, 'vx.config.mjs'), mine)
    const kept = await vx(root, ['init'])
    expect([kept.code, kept.err, await readFile(path.join(root, 'vx.config.mjs'), 'utf8')]).toEqual(
      [0, '', mine],
    )
    expect(kept.out).toContain('  kept      vx.config.mjs\n')
    const forced = await vx(root, ['init', '--force'])
    expect([
      forced.code,
      existsSync(path.join(root, 'vx.config.mjs')),
      await readFile(path.join(root, 'vx.config.ts'), 'utf8'),
    ]).toEqual([0, false, PROJECT])
  })

  // A re-run over a config that already declares tasks still said
  // `declare a task in vx.config.mjs`: the next step is to run one.
  it('a re-run over a config with tasks names one to run, not one to declare', async () => {
    const root = await tmp('vx-init-bare-rerun-')
    expect((await vx(root, ['init', '--mjs'])).out).toContain(
      '  next      declare a task in vx.config.mjs, then vx lock && vx run <task>\n',
    )
    await writeFile(
      path.join(root, 'vx.config.mjs'),
      'export default { tasks: { hi: { exec: { command: "echo hi" } } } }\n',
    )
    const again = await vx(root, ['init', '--mjs'])
    expect([again.code, again.err]).toEqual([0, ''])
    expect(again.out).toContain('  kept      .vx/workspace.mjs\n            vx.config.mjs\n')
    expect(again.out).toContain('  next      vx run hi\n')
  })

  // A root package.json that does not parse read as none: init wrote the
  // starter, locked, and said nothing of the file every manager refuses.
  it('a package.json that does not parse is refused, by file and position', async () => {
    const root = await tmp('vx-init-bare-bad-manifest-')
    await writeFile(path.join(root, 'package.json'), '{\n  "name": "x",\n  "scripts": oops\n}\n')
    await mkdir(path.join(root, 'sub'))
    for (const cwd of [root, path.join(root, 'sub')]) {
      const r = await vx(cwd, ['init'])
      // `bun bin.ts` prints Bun's own dump of the file first; a compiled vx does not.
      const said = r.err.slice(r.err.indexOf('✗ vx init'))
      expect([r.code, said.replace(/ \(JSONC? Parse error[^)]*\)/, ' (…)')]).toEqual([
        1,
        `✗ vx init  ${path.relative(cwd, path.join(root, 'package.json'))}:3:14: not JSON (…); fix it, then run vx init again\n`,
      ])
    }
    expect(existsSync(path.join(root, '.vx'))).toBe(false)
    // CONTROL: bun takes comments and a trailing comma, so init does too.
    await writeFile(path.join(root, 'package.json'), '{\n  // x\n  "name": "x",\n}\n')
    expect((await vx(root, ['init'])).code).toBe(0)
  })

  // `vx init --help` said --force overwrites vx.config.* files; it replaces
  // the workspace file too, and a user lost the plugins it declared.
  it('--force replaces the workspace file, as its help says', async () => {
    const root = await tmp('vx-init-bare-force-ws-')
    await mkdir(path.join(root, '.vx'))
    await writeFile(
      path.join(root, '.vx', 'workspace.ts'),
      'export default { plugins: [] } // mine\n',
    )
    const r = await vx(root, ['init', '--force'])
    expect([r.code, await readFile(path.join(root, '.vx', 'workspace.ts'), 'utf8')]).toEqual([
      0,
      WORKSPACE,
    ])
    // Listed under `files` alone, an overwrite read as a first write.
    expect(r.out).toContain('  replaced  .vx/workspace.ts\n')
    const line = verbHelpText('init')
      .split('\n')
      .find((l) => l.trimStart().startsWith('--force'))
    expect(line).toContain('.vx/workspace.*')
  })

  // 2026-11-07: with vx.config.mjs and vx.config.ts both here, --force
  // replaced only the first found, and the other stayed beside it.
  it('--force replaces every config name already here', async () => {
    const root = await tmp('vx-init-bare-two-')
    for (const n of ['vx.config.mjs', 'vx.config.ts', 'vx.config.js'])
      await writeFile(path.join(root, n), 'export default { tasks: { b: 5 } }\n')
    const r = await vx(root, ['init', '--force'])
    expect([
      r.code,
      ['vx.config.mjs', 'vx.config.js'].filter((n) => existsSync(path.join(root, n))),
      await readFile(path.join(root, 'vx.config.ts'), 'utf8'),
    ]).toEqual([0, [], PROJECT])
    expect(r.out).toContain(
      '  replaced  vx.config.ts\n            vx.config.js\n            vx.config.mjs\n',
    )
  })

  it('a lock that is not written fails init, as vx-migrate fails', async () => {
    // A kept config that does not load printed `lock  not written` and exited 0.
    const root = await tmp('vx-init-bare-badlock-')
    await writeFile(path.join(root, 'vx.config.mjs'), 'export default { tasks: { b: 5 } }\n')
    const r = await vx(root, ['init'])
    expect([r.code, r.out.includes('  lock      not written\n')]).toEqual([1, true])
  })

  it('a file where .vx or plugins goes is one line, not a stack', async () => {
    const root = await tmp('vx-init-bare-dotvx-file-')
    await writeFile(path.join(root, '.vx'), '')
    const r = await vx(root, ['init'])
    expect([r.code, r.err]).toEqual([
      1,
      '✗ vx init  cannot write .vx/workspace.ts: .vx is a file, not a directory; move it and re-run\n',
    ])
    await writeFile(path.join(root, 'plugins'), '')
    const p = await vx(root, ['init', '--plugin', 'cache'])
    expect([p.code, p.err]).toEqual([
      1,
      '✗ vx init  cannot write plugins/package.json: plugins is a file, not a directory; move it and re-run\n',
    ])
  })

  // A directory at .vx/workspace.ts was "kept" and locked, and every verb
  // after found no workspace file and sent the user back to init.
  it('a directory where a config goes is refused by name, --force or not', async () => {
    const root = await tmp('vx-init-bare-dir-')
    await mkdir(path.join(root, '.vx', 'workspace.ts'), { recursive: true })
    for (const args of [['init'], ['init', '--force']]) {
      const r = await vx(root, args)
      expect([r.code, r.err, existsSync(path.join(root, '.vx', 'projects.lock'))]).toEqual([
        1,
        '✗ vx init  .vx/workspace.ts is a directory, where the workspace file goes; move it and re-run\n',
        false,
      ])
    }
    const other = await tmp('vx-init-bare-dir-config-')
    await mkdir(path.join(other, 'vx.config.ts'))
    const f = await vx(other, ['init', '--force'])
    expect([f.code, f.err]).toEqual([
      1,
      '✗ vx init  vx.config.ts is a directory, where the project config goes; move it and re-run\n',
    ])
  })

  it('--native and --keep answer a Turbo or Nx question, and are refused here', async () => {
    const root = await tmp('vx-init-bare-keep-')
    const r = await vx(root, ['init', '--keep'])
    expect([r.code, r.err, existsSync(path.join(root, '.vx'))]).toEqual([
      1,
      "✗ vx init  --keep answers a Turbo or Nx workspace's question, and there is no turbo.json or nx.json here\n",
      false,
    ])
    // A flag this repo cannot take is usage, not the catch-all VX_E_REFUSED.
    const json = await vx(root, ['init', '--native', '--dry', '--format', 'json'])
    expect([json.code, JSON.parse(json.out).error.code]).toEqual([1, 'VX_E_USAGE'])
  })
})

describe('vx init in a Turbo or Nx repo hands over to @vzn/vx-migrate', () => {
  // A stand-in vx-migrate records what it was asked: the suite reads no other package.
  async function jsRepo(tool = 'turbo.json'): Promise<string> {
    const root = await tmp('vx-init-js-')
    await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["packages/*"]}\n')
    await writeFile(path.join(root, tool), '{}\n')
    await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
    await writeFile(
      path.join(root, 'packages', 'a', 'package.json'),
      '{"name":"a","scripts":{"build":"tsc"}}\n',
    )
    const bin = path.join(root, 'node_modules', '@vzn', 'vx-migrate', 'src', 'bin.ts')
    await mkdir(path.dirname(bin), { recursive: true })
    await writeFile(
      bin,
      `await Bun.write(${JSON.stringify(path.join(root, 'asked'))}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }))\n`,
    )
    return root
  }

  it('from the root, with its flags; no file of its own', async () => {
    const root = await jsRepo()
    const r = await vx(root, ['init', '--dry', '--mjs'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect(JSON.parse(await readFile(path.join(root, 'asked'), 'utf8'))).toEqual({
      cwd: root,
      argv: ['--dry', '--mjs'],
    })
    expect(existsSync(path.join(root, '.vx'))).toBe(false)
  })

  it('from a directory below it with no package.json of its own', async () => {
    const root = await jsRepo()
    const docs = path.join(root, 'docs')
    await mkdir(docs)
    const r = await vx(docs, ['init', '--keep'])
    expect([r.code, r.err, existsSync(path.join(docs, 'vx.config.ts'))]).toEqual([0, '', false])
    expect(JSON.parse(await readFile(path.join(root, 'asked'), 'utf8'))).toEqual({
      cwd: docs,
      argv: ['--keep'],
    })
  })

  // vx-migrate maps an Nx workspace from an exported graph or a Lerna repo
  // that runs through Nx as it does from nx.json; init wrote its starter
  // over both and named the scripts mapper instead (2026-11-11).
  it.each([
    ['an exported Nx graph', '.nx/workspace-data/project-graph.json', {}],
    [
      'Lerna on Nx',
      'lerna.json',
      { devDependencies: { lerna: '^8.0.0' }, scripts: { build: 'lerna run build' } },
    ],
  ])('from %s', async (_, file, manifest) => {
    const root = await jsRepo('package.json')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'], ...manifest }),
    )
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), '{}\n')
    const r = await vx(root, ['init', '--dry'])
    expect([r.code, r.err, existsSync(path.join(root, 'asked'))]).toEqual([0, '', true])
  })

  it('CONTROL: a lerna.json no script runs through Lerna stays the starter', async () => {
    const root = await jsRepo('package.json')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'], devDependencies: { lerna: '^8' } }),
    )
    await writeFile(path.join(root, 'lerna.json'), '{}\n')
    const r = await vx(root, ['init', '--dry'])
    expect([r.code, r.err, existsSync(path.join(root, 'asked'))]).toEqual([0, '', false])
  })
})

describe('vx init in a repo with a package.json and no Turbo or Nx', () => {
  it('writes the starter at the topmost package.json, from a directory below it', async () => {
    const root = await tmp('vx-init-pkg-')
    await writeFile(path.join(root, 'package.json'), '{"name":"r","scripts":{"build":"tsc"}}\n')
    const sub = path.join(root, 'packages', 'a')
    await mkdir(sub, { recursive: true })
    await writeFile(path.join(sub, 'package.json'), '{"name":"a"}\n')
    const r = await vx(sub, ['init'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect([
      await readFile(path.join(root, 'vx.config.ts'), 'utf8'),
      existsSync(path.join(root, '.vx', 'workspace.ts')),
      existsSync(path.join(sub, 'vx.config.ts')),
    ]).toEqual([PROJECT, true, false])
  })

  it('names the root it writes at when that is not the working directory', async () => {
    // From a directory below the root the report listed `vx.config.ts`
    // with no word that it lands in a parent (a stray ~/package.json too).
    const root = await tmp('vx-init-where-')
    await writeFile(path.join(root, 'package.json'), '{"name":"r"}\n')
    const sub = path.join(root, 'src')
    await mkdir(sub, { recursive: true })
    const rootRow = (out: string): string | undefined =>
      out
        .split('\n')
        .find((l) => l.trimStart().startsWith('root '))
        ?.trim()
    const below = await vx(sub, ['init', '--dry'])
    const here = await vx(root, ['init', '--dry'])
    expect([below.code, rootRow(below.out), here.code, rootRow(here.out)]).toEqual([
      0,
      `root      ${root}`,
      0,
      undefined,
    ])
  })

  // Outside git there is no top-level to stop at: init climbed to the
  // topmost package.json up to `/`, so a stray one in the home directory
  // took the workspace and its install (2026-10-28). There the root is the
  // nearest package.json, or an outer one that declares a workspace.
  it('outside git, takes the nearest package.json, not a stray one above it', async () => {
    const outer = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-init-nogit-')))
    roots.push(outer)
    await writeFile(path.join(outer, 'package.json'), '{"name":"home"}\n')
    const proj = path.join(outer, 'proj')
    await mkdir(path.join(proj, 'packages', 'a'), { recursive: true })
    await writeFile(path.join(proj, 'package.json'), '{"name":"r","workspaces":["packages/*"]}\n')
    await writeFile(path.join(proj, 'packages', 'a', 'package.json'), '{"name":"a"}\n')
    const env = { GIT_CEILING_DIRECTORIES: path.dirname(outer) }
    const r = await vx(path.join(proj, 'packages', 'a'), ['init'], env)
    expect([r.code, r.err]).toEqual([0, ''])
    expect([
      existsSync(path.join(outer, '.vx')),
      existsSync(path.join(outer, 'vx.config.ts')),
      await readFile(path.join(proj, 'vx.config.ts'), 'utf8'),
    ]).toEqual([false, false, PROJECT])
    const lone = path.join(outer, 'lone')
    await mkdir(lone)
    await writeFile(path.join(lone, 'package.json'), '{"name":"lone"}\n')
    expect((await vx(lone, ['init'], env)).code).toBe(0)
    expect([
      existsSync(path.join(lone, 'vx.config.ts')),
      existsSync(path.join(outer, '.vx')),
    ]).toEqual([true, false])
  })

  // `git init` run in the cwd, below the root init wrote to, hid that workspace.
  it('outside git, next names the directory to git init in when the root is above', async () => {
    const outer = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-init-nogit-next-')))
    roots.push(outer)
    await writeFile(path.join(outer, 'package.json'), '{"name":"stray"}\n')
    await mkdir(path.join(outer, 'app', 'src'), { recursive: true })
    const env = { GIT_CEILING_DIRECTORIES: path.dirname(outer) }
    const next = async (cwd: string): Promise<string> => {
      const r = await vx(cwd, ['init', '--dry', '--format', 'json'], env)
      expect([r.code, r.err]).toEqual([0, ''])
      return (JSON.parse(r.out) as { next: string }).next
    }
    const declare = 'declare a task in vx.config.ts, then vx lock && vx run <task>'
    expect([await next(path.join(outer, 'app', 'src')), await next(outer)]).toEqual([
      `git init ../.., ${declare}`,
      `git init, ${declare}`,
    ])
  })

  // A kept workspace file stood in for the git top-level, so the hint went
  // missing and the next `vx run` refused with "vx requires git".
  it('outside git, next says git init when the workspace file is kept', async () => {
    const outer = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-init-nogit-kept-')))
    roots.push(outer)
    await mkdir(path.join(outer, '.vx'))
    await writeFile(path.join(outer, '.vx', 'workspace.ts'), 'export default {}\n')
    const r = await vx(outer, ['init', '--dry', '--format', 'json'], {
      GIT_CEILING_DIRECTORIES: path.dirname(outer),
    })
    expect([r.code, r.err]).toEqual([0, ''])
    const plan = JSON.parse(r.out) as { kept: string[]; next: string }
    expect([plan.kept, plan.next]).toEqual([
      ['.vx/workspace.ts'],
      'git init, declare a task in vx.config.ts, then vx lock && vx run <task>',
    ])
  })

  // npm strips a byte-order mark, and so does every other package.json
  // read here; the workspace check did not, so a BOM'd root lost to the
  // nearest package.json below it.
  it('outside git, takes an outer workspace whose package.json opens with a BOM', async () => {
    const outer = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-init-bom-')))
    roots.push(outer)
    await writeFile(path.join(outer, 'package.json'), '\uFEFF{"name":"r","workspaces":["a"]}\n')
    await mkdir(path.join(outer, 'a'))
    await writeFile(path.join(outer, 'a', 'package.json'), '{"name":"a"}\n')
    const env = { GIT_CEILING_DIRECTORIES: path.dirname(outer) }
    const r = await vx(path.join(outer, 'a'), ['init', '--dry'], env)
    const root = r.out
      .split('\n')
      .find((l) => l.trimStart().startsWith('root '))
      ?.trim()
    expect([r.code, r.err, root]).toEqual([0, '', `root      ${outer}`])
  })

  // The Turbo or Nx check climbed to `/` outside git, so a stray turbo.json
  // or nx.json above the project handed init to vx-migrate; package.json
  // has stopped at the project's root since 2026-10-28, and so does it.
  it('outside git, a turbo.json or nx.json above the package.json root is not the repo', async () => {
    const outer = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-init-nogit-tool-')))
    roots.push(outer)
    await writeFile(path.join(outer, 'turbo.json'), '{}\n')
    await writeFile(path.join(outer, 'nx.json'), '{}\n')
    const proj = path.join(outer, 'proj')
    await mkdir(proj)
    await writeFile(path.join(proj, 'package.json'), '{"name":"p"}\n')
    const env = {
      GIT_CEILING_DIRECTORIES: path.dirname(outer),
      HOME: outer,
      // Never the network: a hand-off to vx-migrate fails fast instead.
      BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/',
      npm_config_registry: 'http://127.0.0.1:9/',
    }
    const r = await vx(proj, ['init', '--dry', '--format', 'json'], env)
    expect([r.code, r.err]).toEqual([0, ''])
    expect((JSON.parse(r.out) as { source: string }).source).toBe('no turbo.json or nx.json')
  })

  // A Bun workspace with scripts got an empty root project and a `next`
  // that never named the tool that makes scripts tasks (2026-10-26).
  it('names vx-migrate in next when there are scripts to map', async () => {
    const next = async (manifest: string, extra?: [string, string]): Promise<string> => {
      const root = await tmp('vx-init-scripts-')
      await writeFile(path.join(root, 'package.json'), manifest)
      if (extra !== undefined) await writeFile(path.join(root, extra[0]), extra[1])
      const r = await vx(root, ['init', '--dry', '--format', 'json'])
      expect([r.code, r.err]).toEqual([0, ''])
      return (JSON.parse(r.out) as { next: string }).next
    }
    const declare = 'declare a task in vx.config.ts, then vx lock && vx run <task>'
    const mapped = `bunx @vzn/vx-migrate to make package.json scripts tasks, or ${declare}`
    expect([
      await next('{"name":"r","scripts":{"build":"tsc"}}'),
      await next('{"name":"r","private":true,"workspaces":["packages/*"]}'),
      await next('{"name":"r"}', ['pnpm-workspace.yaml', 'packages:\n  - packages/*\n']),
      await next('{"name":"r","scripts":{}}'),
      // A byte-order mark, which npm strips: JSON.parse threw on it.
      await next('﻿{"name":"r","scripts":{"build":"tsc"}}'),
    ]).toEqual([mapped, mapped, mapped, declare, mapped])
  })
})

describe('initInstalls', () => {
  it('installs globally with the runner that started init, and as the root devDependency', async () => {
    const root = await tmp('vx-init-installs-')
    await writeFile(path.join(root, 'package.json'), '{"name":"r"}\n')
    await writeFile(path.join(root, 'pnpm-lock.yaml'), '')
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    expect(initInstalls('1.2.3', 'pnpm/10.0.0 node/v22', root, undefined)).toEqual([
      { argv: ['pnpm', 'add', '-g', '@vzn/vx@1.2.3'], cwd: null },
      {
        argv: ['pnpm', 'add', '@vzn/vx@1.2.3', '--save-dev', '--workspace-root'],
        cwd: root,
      },
      // pnpm 10.19's `add` on create-t3-turbo left a peer set linked that its
      // new lockfile no longer named; the plain install links the lockfile's.
      { argv: ['pnpm', 'install'], cwd: root },
    ])
  })

  it('installs a plugin beside vx at the same version', () => {
    expect(
      initInstalls('1.2.3', 'bun/1.4', '/r', '1.2.3', '/bin/bun', ['@vzn/vx-lockfile']),
    ).toEqual([
      {
        argv: ['npm', 'install', '@vzn/vx@1.2.3', '@vzn/vx-lockfile@1.2.3', '--save-dev'],
        cwd: '/r',
      },
    ])
  })

  it('skips a global vx already at the version; no package.json, no local install', () => {
    expect(initInstalls('1.2.3', undefined, null, '1.2.3')).toEqual([])
    // No runner started init (the compiled binary): Bun, which vx needs anyway, not npm.
    expect(initInstalls('1.2.3', undefined, null, '1.2.2')).toEqual([
      { argv: ['bun', 'add', '-g', '@vzn/vx@1.2.3'], cwd: null },
    ])
  })
})

// v0.0.646's platform tarball answered 404 for minutes after publish, and
// init said only "bun add … failed (exit 1)".
describe('notServed', () => {
  it("names the package a manager's 404 line names, and nothing for any other failure", () => {
    expect(
      [
        'warn: GET https://registry.npmjs.org/@vzn/vx-linux-x64/-/vx-linux-x64-0.0.646.tgz - 404',
        'npm error 404 Not Found - GET https://registry.npmjs.org/@vzn/vx-lockfile/-/vx-lockfile-0.0.646.tgz - Not found',
        ' ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@vzn%2fvx/-/vx-1.2.3.tgz: Not Found - 404',
        'error: ENOSPC: no space left on device',
      ].map(notServed),
    ).toEqual(['@vzn/vx-linux-x64@0.0.646', '@vzn/vx-lockfile@0.0.646', '@vzn/vx@1.2.3', undefined])
  })
})
