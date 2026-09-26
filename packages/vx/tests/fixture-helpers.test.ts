// The fixture helpers every suite builds on (items 846, 847): tests/helpers/
// workspace.ts, local-workspace.ts, plugin.ts, orchestrator-fixture.ts and
// watch-loop.ts. Eighty-odd files lean on them, so a helper that quietly drops an option (a workspace file never
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
import { parseRunArgs } from '../src/cli/index.js'
import type { TaskNode, TaskOutcome } from '../src/graph/index.js'
import { isAlive } from './helpers/alive.js'
import {
  FORCE,
  type Fixture,
  makeWorkspace as makeOrchestratorWorkspace,
  NO_CACHE,
  silentLogger,
  STAMP_CMD,
} from './helpers/orchestrator-fixture.js'
import { pluginOrigin, pluginSource, testPlugin } from './helpers/plugin.js'
import {
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
  type Watch,
} from './helpers/watch-loop.js'
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

describe('the orchestrator fixture', () => {
  it('holds the policies the CLI resolves --no-cache and --force to', () => {
    expect(parseRunArgs(['build', '--no-cache']).cache).toEqual({ ...NO_CACHE })
    expect(parseRunArgs(['build', '--force']).cache).toEqual({ ...FORCE })
  })

  it('records status lines, stderr, and one body per task at completion', () => {
    const f: Fixture = { root: '', log: [], err: [] }
    const logger = silentLogger(f)
    const a = { id: 'p#a' } as TaskNode
    const b = { id: 'p#b' } as TaskNode
    logger.status('started')
    logger.taskStdout(a, 'a1 ')
    logger.taskStderr(b, 'b-err\n')
    logger.taskStdout(a, 'a2\n')
    logger.taskComplete(a, { status: 'success' } as TaskOutcome)
    logger.taskComplete(b, { status: 'failed' } as TaskOutcome)
    // A second completion of the same id carries no stale body.
    logger.taskComplete(a, { status: 'cache-hit' } as TaskOutcome)
    // Whitespace only is no body.
    logger.taskStdout(b, ' \n')
    logger.taskComplete(b, { status: 'success' } as TaskOutcome)
    expect(f.log).toEqual([
      'started',
      'task p#a success',
      'a1 a2',
      'task p#b failed',
      'b-err',
      'task p#a cache-hit',
      'task p#b success',
    ])
    expect(f.err).toEqual(['b-err'])
  })

  it('makes a git workspace under its prefix, and a stamp that differs per run', async () => {
    const f = await makeOrchestratorWorkspace()
    track(f.root)
    expect(path.basename(f.root)).toStartWith('nxt-e2e-')
    expect(existsSync(path.join(f.root, '.git'))).toBe(true)
    expect(f.log).toEqual([])
    expect(f.err).toEqual([])
    expect(path.basename(track((await makeOrchestratorWorkspace('mine-')).root))).toStartWith(
      'mine-',
    )
    const stamp = async (): Promise<string> => {
      Bun.spawnSync(['sh', '-c', STAMP_CMD], { cwd: f.root })
      return text(path.join(f.root, 'out.txt'))
    }
    const one = await stamp()
    await Bun.sleep(2)
    expect(one).toMatch(/^\d{13}$/)
    expect(await stamp()).not.toBe(one)
  })
})

describe('the watch-loop helpers', () => {
  it('until returns once the condition holds and names what it waited for', async () => {
    let n = 0
    await until(() => ++n === 3, 'three')
    expect(n).toBe(3)
    await until(async () => true, 'async')
    // An async condition is awaited, not judged by its promise.
    expect(
      await until(async () => false, 'never', 60).then(
        () => 'ok',
        () => 'timed out',
      ),
    ).toBe('timed out')
    const t0 = Date.now()
    expect(
      await until(() => false, 'the moon', 60).then(
        () => 'ok',
        (e: Error) => e.message,
      ),
    ).toBe('timed out waiting for the moon')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55)
  })

  it('counts executions as the log lines that are exactly `run`', async () => {
    const dir = scratch()
    const log = path.join(dir, 'runs.log')
    expect(await executions(log)).toBe(0)
    await Bun.write(log, 'run\nrunning\nrun\n run\n\nrun')
    expect(await executions(log)).toBe(3)
    const w = { out: () => 'OUTPUT' } as Watch
    expect(
      await initialOnly(w, log).then(
        () => 'ok',
        (e: Error) => e.message,
      ),
    ).toBe('expected the initial run only (1 execution), saw 3; watch output:\nOUTPUT')
    await Bun.write(log, 'run\n')
    await initialOnly(w, log)
    await Bun.write(log, '')
    expect(
      await initialOnly(w, log).then(
        () => 'ok',
        (e: Error) => e.message,
      ),
    ).toStartWith('expected the initial run only (1 execution), saw 0;')
  })
})

describe('the watch fixture', () => {
  const f = useWatchFixture()
  const seen: string[] = []
  it('writes an app whose build concatenates src into dist and logs outside', async () => {
    seen.push(f.root, path.dirname(f.log))
    expect(f.dir).toBe(path.join(f.root, 'packages', 'app'))
    expect(path.basename(f.root)).toStartWith('vx-watch-loop-')
    expect(f.log.startsWith(f.root)).toBe(false)
    expect(await text(path.join(f.dir, 'src', 'a.txt'))).toBe('a1\n')
    const config = await text(path.join(f.dir, 'vx.config.mjs'))
    const command = /command: '([^']+)'/.exec(config)![1]!
    await Bun.write(path.join(f.dir, 'src', 'b.txt'), 'b1\n')
    Bun.spawnSync(['sh', '-c', command], { cwd: f.dir })
    Bun.spawnSync(['sh', '-c', command], { cwd: f.dir })
    expect(await text(path.join(f.dir, 'dist', 'out.txt'))).toBe('a1\nb1\n')
    expect(await executions(f.log)).toBe(2)
    expect(config).toContain("inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }")
    expect(f.watch).toBeUndefined()
  })

  it('ends the case watch and removes both directories after each case', async () => {
    expect(seen.length).toBe(2)
    for (const d of seen) expect(existsSync(d)).toBe(false)
    expect(existsSync(f.root)).toBe(true)
    f.watch = startWatch(f.root)
    await until(() => f.watch!.out().includes('watching'), 'the watch to start')
    expect(f.watch.cycles()).toBe(0)
    seen.push(String(f.watch.proc.pid))
  })

  it('killed the previous case watch', async () => {
    expect(f.watch).toBeUndefined()
    const pid = Number(seen.at(-1))
    expect(Number.isInteger(pid)).toBe(true)
    expect(isAlive(pid)).toBe(false)
  })
})
