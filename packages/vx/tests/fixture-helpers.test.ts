// The fixture helpers every suite builds on (item 846): tests/helpers/
// workspace.ts, local-workspace.ts and plugin.ts. Eighty-odd files lean on
// them, so a helper that quietly drops an option (a workspace file never
// written, a commit that tracks nothing, a scoped name on the wrong path)
// would move every one of those fixtures at once.
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CORE_INDEX,
  localWorkspaceSource,
  PLUGIN_IMPORT,
  writeLocalWorkspace,
} from './helpers/local-workspace.js'
import { pluginOrigin, pluginSource, testPlugin } from './helpers/plugin.js'
import { addProject, gitIn, gitInit, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const track = (d: string): string => (made.push(d), d)
const scratch = (): string => track(realpathSync(mkdtempSync(path.join(tmpdir(), 'vx-fh-'))))
const text = (p: string): Promise<string> => readFile(p, 'utf8')

describe('makeWorkspace', () => {
  it('writes a pnpm root, the workspace file and a git repo by default', async () => {
    const root = track(await makeWorkspace())
    expect(path.basename(root)).toStartWith('vx-ws-')
    expect(path.dirname(root)).toBe(tmpdir())
    expect(readdirSync(root).sort()).toEqual([
      '.git',
      'package.json',
      'packages',
      'pnpm-workspace.yaml',
      'vx.workspace.mjs',
    ])
    expect(await text(path.join(root, 'pnpm-workspace.yaml'))).toBe('packages:\n  - "packages/*"\n')
    expect(JSON.parse(await text(path.join(root, 'package.json')))).toEqual({
      name: 'fixture-root',
      private: true,
    })
    expect(await text(path.join(root, 'vx.workspace.mjs'))).toBe(localWorkspaceSource())
    const git = gitIn(root)
    expect(git('config', 'user.email').trim()).toBe('test@vx.local')
    expect(git('config', 'user.name').trim()).toBe('vx test')
    // init, not commit: nothing is tracked yet.
    expect(git('ls-files')).toBe('')
  })

  it('honours prefix, dir, rootName, workspaceFile and git: false', async () => {
    const dir = scratch()
    const root = await makeWorkspace({
      prefix: 'suite-x-',
      dir,
      rootName: 'named-root',
      workspaceFile: false,
      git: false,
    })
    expect(path.dirname(root)).toBe(dir)
    expect(path.basename(root)).toStartWith('suite-x-')
    expect(readdirSync(root).sort()).toEqual(['package.json', 'packages', 'pnpm-workspace.yaml'])
    expect(JSON.parse(await text(path.join(root, 'package.json'))).name).toBe('named-root')
  })

  it("git: 'commit' tracks everything written so far", async () => {
    const root = track(await makeWorkspace({ git: 'commit' }))
    const git = gitIn(root)
    expect(git('ls-files').trim().split('\n').sort()).toEqual([
      'package.json',
      'pnpm-workspace.yaml',
      'vx.workspace.mjs',
    ])
    expect(git('status', '--porcelain')).toBe('')
    expect(git('log', '--format=%s').trim()).toBe('init')
  })
})

describe('git helpers', () => {
  it('gitIn returns stdout and throws with the command and stderr', () => {
    const dir = scratch()
    gitInit(dir)
    const git = gitIn(dir)
    expect(git('rev-parse', '--is-inside-work-tree')).toBe('true\n')
    expect(() => git('rev-parse', '--verify', 'no-such-ref')).toThrow(
      /^git rev-parse --verify no-such-ref failed: fatal: /,
    )
  })

  it('gitInitCommit commits under the given message with signing off', async () => {
    const dir = scratch()
    await Bun.write(path.join(dir, 'a.txt'), 'a')
    gitInitCommit(dir, 'first')
    const git = gitIn(dir)
    expect(git('log', '--format=%s|%ae').trim()).toBe('first|test@vx.local')
    // A signing config the repo would honour, but for gitIn's own -c.
    git('config', 'commit.gpgsign', 'true')
    git('config', 'gpg.program', 'false')
    await Bun.write(path.join(dir, 'b.txt'), 'b')
    git('add', '-A')
    git('commit', '-q', '-m', 'second')
    expect(git('log', '--format=%s').trim().split('\n')).toEqual(['second', 'first'])
  })
})

describe('addProject', () => {
  it('writes a manifest, the config and nested files', async () => {
    const root = track(await makeWorkspace({ git: false }))
    const dir = await addProject(root, 'app', {
      config: 'export default {}\n',
      deps: { lib: 'workspace:*' },
      devDeps: { tool: '1.0.0' },
      files: { 'src/deep/a.ts': 'x', 'b.txt': 'y' },
    })
    expect(dir).toBe(path.join(root, 'packages', 'app'))
    expect(JSON.parse(await text(path.join(dir, 'package.json')))).toEqual({
      name: 'app',
      version: '0.0.0',
      dependencies: { lib: 'workspace:*' },
      devDependencies: { tool: '1.0.0' },
    })
    expect(await text(path.join(dir, 'vx.config.mjs'))).toBe('export default {}\n')
    expect(await text(path.join(dir, 'src/deep/a.ts'))).toBe('x')
    expect(await text(path.join(dir, 'b.txt'))).toBe('y')
  })

  it('takes a bare string as the config, and leaves empty maps out', async () => {
    const root = track(await makeWorkspace({ git: false }))
    const a = await addProject(root, 'a', 'cfg')
    expect(await text(path.join(a, 'vx.config.mjs'))).toBe('cfg')
    // An empty config is still a config file.
    expect(await text(path.join(await addProject(root, 'e', ''), 'vx.config.mjs'))).toBe('')
    const b = await addProject(root, 'b', { deps: {}, devDeps: {} })
    expect(JSON.parse(await text(path.join(b, 'package.json')))).toEqual({
      name: 'b',
      version: '0.0.0',
    })
    expect(existsSync(path.join(b, 'package.json'))).toBe(true)
    expect(existsSync(path.join(b, 'vx.config.mjs'))).toBe(false)
  })

  it('puts a scoped name under packages/scope-name', async () => {
    const root = track(await makeWorkspace({ git: false }))
    const dir = await addProject(root, '@org/pkg')
    expect(dir).toBe(path.join(root, 'packages', 'org-pkg'))
    expect(JSON.parse(await text(path.join(dir, 'package.json'))).name).toBe('@org/pkg')
  })
})

describe('the local workspace source', () => {
  it('imports definePlugin from core by absolute path', async () => {
    expect(CORE_INDEX).toBe(path.resolve(import.meta.dir, '../src/index.ts'))
    expect(existsSync(CORE_INDEX)).toBe(true)
    expect(PLUGIN_IMPORT).toBe(`import { definePlugin } from ${JSON.stringify(CORE_INDEX)}\n`)
    expect(localWorkspaceSource()).toBe(`${PLUGIN_IMPORT}\nexport default { plugins: [] }\n`)
    expect(localWorkspaceSource(['a()', 'b()'], 'const a = 1\n')).toBe(
      `${PLUGIN_IMPORT}const a = 1\n\nexport default { plugins: [a(), b()] }\n`,
    )
    const dir = scratch()
    await writeLocalWorkspace(dir)
    const mod = await import(path.join(dir, 'vx.workspace.mjs'))
    expect(mod.default).toEqual({ plugins: [] })
  })
})

describe('test plugins', () => {
  it('names a plugin by a package made for it, once per name', async () => {
    const a = pluginOrigin('@org/x')
    expect(path.basename(a.dir)).toBe('_org_x')
    expect(path.basename(path.dirname(a.dir))).toStartWith(`vx-plugin-pkgs-${process.pid}-`)
    expect(JSON.parse(await text(path.join(a.dir, 'package.json')))).toEqual({ name: '@org/x' })
    expect(pluginOrigin('@org/x')).toEqual(a)
    expect(pluginOrigin('other').dir).not.toBe(a.dir)
    expect(path.dirname(pluginOrigin('other').dir)).toBe(path.dirname(a.dir))
    expect(testPlugin('@org/x', {}).name).toBe('@org/x')
    expect(pluginSource('@org/x', '{ setup() {} }')).toBe(
      `definePlugin(${JSON.stringify(a)}, { setup() {} })`,
    )
  })

  it("sweeps a dead process's root and keeps a live one's", async () => {
    const tmp = scratch()
    // A pid past the kernel's limit is dead; this process is alive.
    const dead = path.join(tmp, 'vx-plugin-pkgs-99999999-old')
    const live = path.join(tmp, `vx-plugin-pkgs-${process.pid}-mine`)
    // Only a name that STARTS with the prefix and a pid is a root.
    const other = path.join(tmp, 'vx-plugin-pkgs-x-99999999')
    const inner = path.join(tmp, 'keep-vx-plugin-pkgs-99999999-z')
    for (const d of [dead, live, other, inner]) mkdirSync(d)
    const helper = path.join(import.meta.dir, 'helpers/plugin.ts')
    const p = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `const { pluginOrigin } = await import(${JSON.stringify(helper)}); console.log(pluginOrigin('p').dir)`,
      ],
      env: { ...process.env, TMPDIR: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(p.stderr.toString()).toBe('')
    expect(p.exitCode).toBe(0)
    const made = p.stdout.toString().trim()
    expect(path.dirname(path.dirname(made))).toBe(tmp)
    expect(existsSync(made)).toBe(true)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(inner)).toBe(true)
    expect(existsSync(dead)).toBe(false)
  })
})
