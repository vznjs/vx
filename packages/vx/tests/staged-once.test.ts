// A run stages each locked config ONCE. The CLI's selection pass
// stages every config when a filter walks the graph (`app...`,
// `--affected` with a diff) to read the `pkg#task` edges; the run used to
// load them all again — the `project` stage's cost paid twice, its
// warnings printed twice (seen on solidjs/solid under `@vzn/vx-migrate`:
// every "no vx equivalent" line doubled under `--affected`). The staged
// load now travels into the run (`RunOptions.staged`) and `vx watch`
// shares its sweep with the watched-set walk, while every cycle after an
// edit stages again. The counter is a `project` plugin that appends the
// project's name to a file outside the workspace; `vx lock`'s own staging
// is cleared before each count.
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

describe('the project stage runs once per project per run', () => {
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
            inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
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

  it("a graph-walking filter stages each config once: the run reuses the selection pass's load", async () => {
    // Differential: with `staged` not handed from resolveFilters to the
    // run, each name appears twice.
    const r = await vx('run', 'build', '--filter', 'app...')
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(await stageCalls(counter)).toEqual(['app', 'lib'])
  }, 30_000)

  it('--affected with a root path no project owns stages each config once: the owners walk and the run share the load', async () => {
    // A changed file outside every project is an orphan, and finding
    // which project's `workspaceFiles` glob covers it needs every config
    // staged (`workspaceGlobOwners`); before this, that was a second load
    // — the run did not reuse it. Seen on solidjs/solid: a lockfile edit
    // is an orphan even when a plugin claims it, so every `@vzn/vx-migrate`
    // warning printed twice under `--affected`.
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-qm', 'base')
    await writeFile(path.join(root, 'notes.md'), 'orphan\n')
    await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
    const r = await vx('run', 'build', '--affected=HEAD')
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
    expect(await stageCalls(counter)).toEqual(['app', 'lib'])
  }, 30_000)

  it('a plain scope stages each config once too (the control: no selection load to reuse)', async () => {
    const r = await vx('run', 'build', '--all')
    expect(r.code).toBe(0)
    expect(await stageCalls(counter)).toEqual(['app', 'lib'])
  }, 30_000)

  it('vx watch shares its sweep with the watched-set walk, and every cycle stages again', async () => {
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
      // The initial run (app + its closure) and the sweep (every config):
      // two loads. Differential: with the sweep's load not handed to
      // `watchedProjects`, a third load makes it six.
      expect(await stageCalls(counter)).toEqual(['app', 'app', 'lib', 'lib'])
      await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
      await until(
        async () => (await stageCalls(counter)).length === 6,
        'the cycle after the edit to stage again',
      )
      expect(await stageCalls(counter)).toEqual(['app', 'app', 'app', 'lib', 'lib', 'lib'])
    } finally {
      proc.kill('SIGTERM')
      await proc.exited
    }
  }, 40_000)
})
