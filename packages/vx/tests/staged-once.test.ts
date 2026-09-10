// A run evaluates and stages each config ONCE. The CLI's selection pass
// stages every config when a filter walks the graph (`app...`,
// `--affected` with a diff) to read the `pkg#task` edges; the run used to
// load them all again — the `project` stage's cost paid twice, its
// warnings printed twice (seen on solidjs/solid under `@vzn/vx-turbo`:
// every "no vx equivalent" line doubled under `--affected`). The staged
// load now travels into the run (`RunOptions.staged`) and `vx watch`
// shares its sweep with the watched-set walk, while every cycle after an
// edit still evaluates live. The counter is a `project` plugin that
// appends the project's name to a file outside the workspace.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { PLUGIN_IMPORT } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'

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
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}import { appendFileSync } from 'node:fs'
export default { plugins: [${pluginSource(
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
            cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
          },
        },
      }
    `
    lib = await addProject(root, 'lib', { config: task, files: { 'src/l.txt': 'l1\n' } })
    await addProject(root, 'app', {
      config: task,
      deps: { lib: '0.0.0' },
      files: { 'src/a.txt': 'a1\n' },
    })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const vx = async (...args: string[]) => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
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

  it('a plain scope stages each config once too (the control: no selection load to reuse)', async () => {
    const r = await vx('run', 'build', '--all')
    expect(r.code).toBe(0)
    expect(await stageCalls(counter)).toEqual(['app', 'lib'])
  }, 30_000)

  it('vx watch shares its sweep with the watched-set walk, and every cycle evaluates live', async () => {
    const proc = Bun.spawn([process.execPath, BIN, 'watch', 'build', '--filter', 'app'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, VX_KILL_GRACE_MS: '200' },
    })
    let out = ''
    void (async () => {
      for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk)
    })()
    try {
      await until(
        async () => out.includes('vx watch: watching 2 project(s)'),
        'the watching marker',
      )
      // The initial run (app + its closure) and the sweep (every config):
      // two loads. Differential: with the sweep's load not handed to
      // `watchedProjects`, a third load makes it six.
      expect(await stageCalls(counter)).toEqual(['app', 'app', 'lib', 'lib'])
      await writeFile(path.join(lib, 'src', 'l.txt'), 'l2\n')
      await until(
        async () => (await stageCalls(counter)).length === 6,
        'the cycle after the edit to stage live',
      )
      expect(await stageCalls(counter)).toEqual(['app', 'app', 'app', 'lib', 'lib', 'lib'])
    } finally {
      proc.kill('SIGTERM')
      await proc.exited
    }
  }, 40_000)
})
