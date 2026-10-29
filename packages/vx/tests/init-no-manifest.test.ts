// `vx init` outside a Turbo or Nx repo writes the workspace file and one
// empty root project, then the lock; a Turbo or Nx repo is handed to
// @vzn/vx-migrate (2026-10-20). A source checkout installs nothing:
// `initInstalls` is the plan a release runs.

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { initInstalls, notServed } from '../src/cli/init.js'
import { ui } from '../src/util/index.js'
import { VERSION } from '../src/version.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
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

async function vx(cwd: string, args: string[]) {
  // The `next:` line names the runner that started vx; none here.
  const { npm_config_user_agent: _, ...env } = process.env
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env,
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

const WORKSPACE =
  "import { defineWorkspace } from '@vzn/vx'\n\nexport default defineWorkspace({ plugins: [] })\n"
const PROJECT =
  "import { defineProject } from '@vzn/vx'\n\nexport default defineProject({ tasks: {} })\n"

describe('vx init with no package.json', () => {
  it('writes the workspace file and an empty root project, then the lock', async () => {
    const root = await tmp('vx-init-bare-')
    const r = await vx(root, ['init'])
    expect([r.code, r.err]).toEqual([0, ''])
    expect([
      await readFile(path.join(root, '.vx', 'workspace.ts'), 'utf8'),
      await readFile(path.join(root, 'vx.config.ts'), 'utf8'),
      existsSync(path.join(root, '.vx', '.gitignore')),
      existsSync(path.join(root, '.vx', 'projects.lock.json')),
      existsSync(path.join(root, 'package.json')),
    ]).toEqual([WORKSPACE, PROJECT, true, true, false])
    expect(r.out).toBe(
      ui.render(
        [
          ui.report(`vx init ${VERSION}`, [
            ['from', 'no turbo.json or nx.json: one project, the root'],
            ['files', '.vx/workspace.ts', 'vx.config.ts', '.vx/.gitignore', '.vx/.gitattributes'],
            ['lock', '1 project config → .vx/projects.lock.json'],
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

  it('--dry --mjs writes nothing and prints the .mjs files', async () => {
    const root = await tmp('vx-init-bare-dry-')
    const r = await vx(root, ['init', '--dry', '--mjs'])
    expect([r.code, r.err, existsSync(path.join(root, '.vx'))]).toEqual([0, '', false])
    expect(r.out).toContain(`── .vx/workspace.mjs ──\n${WORKSPACE}`)
    expect(r.out).toContain(`── vx.config.mjs ──\n${PROJECT}`)
    expect(r.out).toContain(
      '  dry run   nothing written\n' +
        '  files     .vx/workspace.mjs\n' +
        '            vx.config.mjs\n' +
        '            .vx/.gitignore\n' +
        '            .vx/.gitattributes\n',
    )
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
      '✗ vx init  cannot write plugins/cache.ts: plugins is a file, not a directory; move it and re-run\n',
    ])
  })

  it('--native and --keep answer a Turbo or Nx question, and are refused here', async () => {
    const root = await tmp('vx-init-bare-keep-')
    const r = await vx(root, ['init', '--keep'])
    expect([r.code, r.err, existsSync(path.join(root, '.vx'))]).toEqual([
      1,
      "✗ vx init  --keep answers a Turbo or Nx repo's question, and there is no turbo.json or nx.json here\n",
      false,
    ])
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
    ]).toEqual([mapped, mapped, mapped, declare])
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
