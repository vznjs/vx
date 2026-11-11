// A run calls no `project` hook: `vx lock` runs the stage and records
// what it left, and every run reads the record (2026-11-11). Before, the
// stage ran on every run — once per run since the selection pass's load
// travelled into the run (`RunOptions.staged`), twice before that (seen on
// solidjs/solid under `@vzn/vx-migrate`: every "no vx equivalent" line
// doubled under `--affected`). The counter is a `project` plugin that
// appends the project's name to a file outside the workspace; `vx lock`'s
// own staging is cleared before each count.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { PLUGIN_IMPORT } from './helpers/local-workspace.js'
import { edgesSource, pluginSource } from './helpers/plugin.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

async function stageCalls(file: string): Promise<string[]> {
  const f = Bun.file(file)
  if (!(await f.exists())) return []
  return (await f.text())
    .split('\n')
    .filter((l) => l !== '')
    .sort()
}

async function until(
  cond: () => Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('a run calls no project hook', () => {
  let root: string
  let outside: string
  let counter: string
  let lib: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-staged-once-' })
    outside = await mkdtemp(path.join(os.tmpdir(), 'vx-staged-count-'))
    counter = path.join(outside, 'stage.log')
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      `${PLUGIN_IMPORT}import { appendFileSync } from 'node:fs'
export default { plugins: [${edgesSource({ app: ['lib'] })}, ${pluginSource(
        'counter',
        `{ project(config, ctx) { appendFileSync(${JSON.stringify(counter)}, ctx.name + '\\n') } }`,
      )}] }\n`,
    )
    const task = `
      export default {
        tasks: {
          build: {
            dependsOn: ['^build'],
            exec: { command: 'true' },
            inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
          },
        },
      }
    `
    lib = await addProject(root, 'lib', { config: task, files: { 'src/l.txt': 'l1\n' } })
    await addProject(root, 'app', {
      config: task,
      files: { 'src/a.txt': 'a1\n' },
    })
    const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
      cwd: root,
      stderr: 'pipe',
      env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
    })
    expect(lock.stderr.toString()).toBe('')
    await rm(counter)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const vx = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
      // The preload's VX_CACHE_DIR: a spawn with no env saved into ~/.vx.
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    return { code, err: await new Response(proc.stderr).text() }
  }

  it('a graph-walking filter calls none', async () => {
    const r = await vx('run', 'build', '--filter', 'app...')
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(await stageCalls(counter)).toEqual([])
  }, 30_000)

  it('--affected with a root path no project owns calls none', async () => {
    // A changed file outside every project is an orphan, and finding
    // which project's `workspaceFiles` glob covers it needs every config
    // staged (`workspaceGlobOwners`).
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-qm', 'base')
    await writeFile(path.join(root, 'notes.md'), 'orphan\n')
    await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
    const r = await vx('run', 'build', '--affected=HEAD')
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(await stageCalls(counter)).toEqual([])
  }, 30_000)

  it('a plain scope calls none; vx lock calls each once', async () => {
    const r = await vx('run', 'build', '--all')
    expect(r.code).toBe(0)
    expect(await stageCalls(counter)).toEqual([])
    expect((await vx('lock')).code).toBe(0)
    expect(await stageCalls(counter)).toEqual(['app', 'lib'])
  }, 30_000)

  it('vx watch calls none, a cycle after an edit neither', async () => {
    const proc = Bun.spawn([process.execPath, BIN, 'watch', 'build', '--filter', 'app'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, VX_TEST_KILL_GRACE: '200ms' },
    })
    let out = ''
    void (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    try {
      await until(async () => out.includes('watching 2 projects'), 'the watching marker')
      expect(await stageCalls(counter)).toEqual([])
      const runs = out.split('lib#build').length
      await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
      await until(async () => out.split('lib#build').length > runs, 'the cycle after the edit')
      expect(await stageCalls(counter)).toEqual([])
    } finally {
      proc.kill('SIGTERM')
      await proc.exited
    }
  }, 40_000)
})
