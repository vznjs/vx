// `--affected` and `--profile` take their value with `=` only, so `vx run
// --affected main build` reads `main` as a task. The refusal named `main`
// and told the user to re-lock; it now names the `=` form they meant.
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseRunArgs } from '../src/cli/run.js'
import { run } from './helpers/cli.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { noticed } from './helpers/notice.js'
import { lock } from './helpers/orchestrator.js'

describe('parseRunArgs', () => {
  it('keeps the word after a bare --affected or --profile, and not a flag', () => {
    expect(parseRunArgs(['--affected', 'main', 'build']).spaced).toEqual({
      flag: '--affected',
      value: 'main',
    })
    expect(parseRunArgs(['--profile', 'out.json', 'build']).spaced).toEqual({
      flag: '--profile',
      value: 'out.json',
    })
    expect(parseRunArgs(['--affected', '--all', 'build']).spaced).toBeUndefined()
    expect(parseRunArgs(['--affected=main', 'build']).spaced).toBeUndefined()
  })
})

describe('a word after a bare --affected or --profile that no project declares', () => {
  let root: string
  let stderr: string
  const origCwd = process.cwd()
  const git = (...args: string[]): void => {
    const r = Bun.spawnSync({ cmd: ['git', ...args], cwd: root })
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  }

  beforeEach(async () => {
    stderr = ''
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-run-spaced-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['p'] }))
    await writeLocalWorkspace(root)
    await mkdir(path.join(root, 'p'))
    await writeFile(path.join(root, 'p', 'package.json'), JSON.stringify({ name: 'p' }))
    await writeFile(
      path.join(root, 'p', 'vx.config.mjs'),
      `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
    )
    git('init', '-q', '-b', 'main')
    await lock(root)
    git('add', '-A')
    git(
      '-c',
      'user.email=c@vx',
      '-c',
      'user.name=c',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init',
    )
    git('checkout', '-q', '-b', 'feat')
    process.chdir(root)
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    process.chdir(origCwd)
    await rm(root, { recursive: true, force: true })
  })

  it('--affected: names the = form when nothing changed', async () => {
    expect(await run(['run', '--affected', 'main', 'build'])).toBe(1)
    expect(stderr).toBe(
      noticed(
        "vx run: no projects declare task(s): main. `--affected` takes its base with '=': --affected=main",
      ),
    )
  })

  it('--affected: names the = form when a project changed', async () => {
    await writeFile(path.join(root, 'p', 'x.txt'), 'x')
    expect(await run(['run', '--affected', 'main', 'build'])).toBe(1)
    expect(stderr).toContain("`--affected` takes its base with '=': --affected=main")
  })

  it('--profile: names the = form, and --dry does too', async () => {
    expect(await run(['run', '--all', '--profile', 'out.json', 'build'])).toBe(1)
    expect(stderr).toContain("`--profile` takes its file with '=': --profile=out.json")
    stderr = ''
    expect(await run(['run', '--all', '--affected', 'main', 'build', '--dry'])).toBe(1)
    expect(stderr).toContain("`--affected` takes its base with '=': --affected=main")
  })

  it('vx watch names the = form too', async () => {
    expect(await run(['watch', '--affected', 'main', 'build'])).toBe(1)
    expect(stderr).toContain("`--affected` takes its base with '=': --affected=main")
  })

  it('vx show names the = form, and not for a target named apart from the flag', async () => {
    await expect(run(['show', '--affected', 'main'])).rejects.toThrow(
      /"main"; projects and tasks: build, p\. `--affected` takes its base with '=': --affected=main$/,
    )
    await expect(run(['show', 'main', '--affected'])).rejects.toThrow(
      /"main"; projects and tasks: build, p$/,
    )
  })

  it('a declared word is the task it names: the other refusal says nothing of the flag', async () => {
    expect(await run(['run', '--all', '--profile', 'build', 'typo'])).toBe(1)
    expect(stderr).toContain('no projects declare task(s): typo')
    expect(stderr).not.toContain('takes its')
  })
})
