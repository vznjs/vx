// A run reads `.vx/projects.lock` and runs what it holds (owner, 2026-11-25:
// "No vx lock, we run what's already logged"). It never evaluates a
// vx.config, a file one imports, the workspace file's plugin options or a
// file a `project` plugin mapped from, and never refuses an edit to one:
// only `vx lock` and `vx lock --check` read them.
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, git, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

// Each evaluation appends a line to `marker`: a run that read the config
// leaves a file `vx lock`'s was removed from.
const config = (word: string, marker?: string) => `
  ${marker === undefined ? '' : `import { appendFileSync } from 'node:fs'\n  appendFileSync(${JSON.stringify(marker)}, 'x\\n')`}
  export default { tasks: { say: { exec: { command: 'echo said-${word}' } } } }
`

async function vx(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    VX_LOCK_REVIEW_FILES: 'false',
  }
  delete env['CI']
  delete env['GITHUB_ACTIONS']
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

/** The exit, the `said-*` words the output holds, and the output. */
async function said(root: string, args: string[]): Promise<[number, string[], string]> {
  const { code, out } = await vx(root, args)
  return [code, [...new Set(out.match(/said-\w+/g) ?? [])].sort(), out]
}

describe('a config edited since vx lock', () => {
  let root: string
  let file: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-edited-' })
    file = path.join(await addProject(root, 'core', config('before')), 'vx.config.mjs')
    expect((await vx(root, ['lock'])).code).toBe(0)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs the locked command, and the edited one once `vx lock` read it', async () => {
    await writeFile(file, config('after'))
    const [code, words, out] = await said(root, ['run', 'core#say', '--no-cache'])
    expect({ code, words, refused: out.includes('vx lock') }).toEqual({
      code: 0,
      words: ['said-before'],
      refused: false,
    })
    // Never relocked; `vx lock --check` still evaluates and names the edit.
    expect(await readFile(path.join(root, '.vx', 'projects.lock'), 'utf8')).toContain('before')
    expect((await vx(root, ['lock', '--check'])).code).toBe(1)
    expect((await vx(root, ['lock'])).code).toBe(0)
    expect((await said(root, ['run', 'core#say', '--no-cache'])).slice(0, 2)).toEqual([
      0,
      ['said-after'],
    ])
  })

  it('runs the locked command though the config no longer evaluates', async () => {
    await writeFile(file, "throw new Error('boom in the config')\n")
    const [code, words, out] = await said(root, ['run', 'core#say', '--no-cache'])
    expect({ code, words, boom: out.includes('boom') }).toEqual({
      code: 0,
      words: ['said-before'],
      boom: false,
    })
    expect((await vx(root, ['show', 'core'])).code).toBe(0)
  })

  it('runs the locked command of a config deleted from a directory still there', async () => {
    await rm(file)
    expect((await said(root, ['run', 'core#say', '--no-cache'])).slice(0, 2)).toEqual([
      0,
      ['said-before'],
    ])
  })

  it('refuses a locked project whose directory is gone, naming `vx lock`', async () => {
    await rm(path.dirname(file), { recursive: true })
    const { code, out } = await vx(root, ['run', 'say', '--all'])
    expect(code).toBe(1)
    expect(out).toContain(
      '.vx/projects.lock locks packages/core ("core"), but its directory is gone — run `vx lock`',
    )
  })

  it('leaves nothing for git to commit in .vx/cache', async () => {
    const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
    })
    const listed = status.stdout.toString()
    expect(listed).toContain('.vx/projects.lock')
    expect(listed).not.toContain('.vx/cache')
  })
})

// A clone, or a cleared cache, has nothing beside the lock: the run evaluated
// every config once to compare it with the lock.
describe('a fresh clone', () => {
  let root: string
  let marker: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-clone-' })
    marker = path.join(root, 'evaluations.txt')
    await addProject(root, 'core', config('before', marker))
    expect((await vx(root, ['lock'])).code).toBe(0)
    expect(existsSync(marker)).toBe(true)
    await rm(marker)
    await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs without evaluating any config', async () => {
    expect((await said(root, ['run', 'core#say'])).slice(0, 2)).toEqual([0, ['said-before']])
    expect(existsSync(marker)).toBe(false)
    // CONTROL: the marker is the evaluation's.
    expect((await vx(root, ['lock', '--check'])).code).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })
})

describe('a file a config imports, edited since vx lock', () => {
  let root: string
  let words: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-import-' })
    const dir = await addProject(
      root,
      'core',
      `import { word } from './words.mjs'\nexport default { tasks: { say: { exec: { command: 'echo said-' + word } } } }\n`,
    )
    words = path.join(dir, 'words.mjs')
    await writeFile(words, "export const word = 'before'\n")
    expect((await vx(root, ['lock'])).code).toBe(0)
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'lock')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs the locked command', async () => {
    await writeFile(words, "export const word = 'after'\n")
    expect((await said(root, ['run', 'core#say', '--no-cache'])).slice(0, 2)).toEqual([
      0,
      ['said-before'],
    ])
  })
})

// The mapper marks each call of its `project` hook: a run calls none.
describe('a file a project plugin mapped from, edited since vx lock', () => {
  const MAPPER = pluginSource(
    'org/mapper',
    `{ project(config, ctx) {
        const fs = require('node:fs')
        const p = require('node:path')
        fs.appendFileSync(p.join(ctx.workspaceRoot, 'hooked.txt'), ctx.name + '\\n')
        const at = p.join(ctx.workspaceRoot, 'mapping.txt')
        ctx.read(at)
        const word = fs.readFileSync(at, 'utf8').trim()
        if (ctx.name === 'bare') config.tasks = { say: { exec: { command: 'echo said-' + word } } }
      } }`,
  )
  let root: string
  const hooked = () => path.join(root, 'hooked.txt')
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-lock-mapped-' })
    await addProject(root, 'bare')
    await writeFile(path.join(root, 'mapping.txt'), 'one\n')
    await writeFile(path.join(root, '.vx', 'workspace.mjs'), localWorkspaceSource([MAPPER]))
    const locked = await vx(root, ['lock'])
    expect(`${locked.code}\n${locked.out}`).toStartWith('0\n')
    expect(existsSync(hooked())).toBe(true)
    await rm(hooked())
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  for (const clone of [false, true]) {
    it(`runs the locked mapping and calls no hook${clone ? ' in a fresh clone' : ''}`, async () => {
      if (clone) await rm(path.join(root, '.vx', 'cache'), { recursive: true, force: true })
      await writeFile(path.join(root, 'mapping.txt'), 'two\n')
      expect((await said(root, ['run', 'bare#say', '--no-cache'])).slice(0, 2)).toEqual([
        0,
        ['said-one'],
      ])
      expect(existsSync(hooked())).toBe(false)
    })
  }

  it('runs the locked mapping after a plugin option in the workspace file moved', async () => {
    await writeFile(
      path.join(root, '.vx', 'workspace.mjs'),
      localWorkspaceSource([MAPPER], '', undefined, 'run: { concurrency: 3 }'),
    )
    await writeFile(path.join(root, 'mapping.txt'), 'two\n')
    expect((await said(root, ['run', 'bare#say', '--no-cache'])).slice(0, 2)).toEqual([
      0,
      ['said-one'],
    ])
    expect(existsSync(hooked())).toBe(false)
  })
})
