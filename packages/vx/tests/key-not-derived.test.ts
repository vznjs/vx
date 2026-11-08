// A task whose key cannot be derived (a runtime probe that exits non-zero)
// never runs its command. `--dry` exited 0 and planned it as runnable while
// the run failed it; the run's frame showed the command, `failed (exit 1)`
// and a `miss`, as if the command had run; a probe's whole output went into
// the error, 5 MB of it.
import { realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
let root: string
beforeEach(async () => {
  root = realpathSync(await makeWorkspace({ prefix: 'vx-key-fail-' }))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function project(inputs: string): Promise<void> {
  await addProject(
    root,
    'app',
    `export default { tasks: {
      build: {
        exec: { command: 'echo RAN > ran.txt' },
        inputs: { files: ['package.json'], ${inputs} },
        outputs: { files: [] },
        cache: true,
      },
      test: { exec: { command: 'true' }, dependsOn: ['build'], inputs: { files: ['package.json'] }, outputs: { files: [] }, cache: true },
    } }`,
  )
}

async function vx(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

it("--dry exits 1 with the run's error line when a task's key cannot be derived", async () => {
  await project(`runtime: ['exit 7']`)
  const cwd = path.join(root, 'packages', 'app')
  const line = `[vx] app#build: cache key not derived: inputs.runtime probe exited 7: exit 7 (cwd: ${cwd})\n`
  const dry = await vx('run', 'test', '--all', '--dry')
  expect({ code: dry.code, err: dry.err }).toEqual({ code: 1, err: line })
  const json = await vx('run', 'test', '--all', '--dry=json')
  expect({ code: json.code, err: json.err }).toEqual({ code: 1, err: line })
  // The plan document is still printed whole on stdout.
  expect(
    JSON.parse(json.out)
      .tasks.map((t: { id: string }) => t.id)
      .sort(),
  ).toEqual(['app#build', 'app#test'])
  const run = await vx('run', 'test', '--all')
  expect(run.code).toBe(1)
  expect(run.out + run.err).toContain(line)
}, 60_000)

it('a run says the key was not derived, naming the probe, and never shows the command', async () => {
  await project(`workspaceRuntime: ['exit 7']`)
  const r = await vx('run', 'build', '--all')
  const all = r.out + r.err
  expect(r.code).toBe(1)
  expect(all).toContain(
    `[vx] app#build: cache key not derived: inputs.workspaceRuntime probe exited 7: exit 7 (cwd: ${root})`,
  )
  expect(all).toContain('failed (cache key not derived)')
  expect(all).not.toContain('$ echo RAN')
  expect(all).not.toContain('failed (exit 1)')
  expect(all).not.toMatch(/failed +miss/)
  expect(await Bun.file(path.join(root, 'packages', 'app', 'ran.txt')).exists()).toBe(false)
}, 60_000)

it("a failed probe's output in the error is capped, its tail kept", async () => {
  await project(`runtime: ['yes abcdefghij | head -c 5000000; echo END; exit 2']`)
  const r = await vx('run', 'build', '--all', '--dry')
  expect(r.code).toBe(1)
  expect(r.err.length).toBeLessThan(100_000)
  expect(r.err).toContain('earlier characters dropped')
  expect(r.err.trimEnd().endsWith('END')).toBe(true)
}, 60_000)
