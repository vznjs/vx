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
import { vx as spawnVx } from './helpers/vx.js'

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

const vx = (...args: string[]) => spawnVx(root, args)

it("--dry exits 1 with the run's error line when a task's key cannot be derived", async () => {
  await project(`runtime: ['exit 7']`)
  const cwd = path.join(root, 'packages', 'app')
  const line = `[vx] app#build: cache key not derived: inputs.runtime probe exited 7: exit 7 (cwd: ${cwd})\n`
  const dry = await vx('run', 'test', '--all', '--dry')
  expect({ code: dry.code, err: dry.err }).toEqual({ code: 1, err: line })
  const json = await vx('run', 'test', '--all', '--dry', '--format', 'json')
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

// History read the same task as an exit-1 cache miss, `vx last --log` blamed
// a 50-run limit for the output it never kept, and `vx why` said "skipped, or
// a persistent task" of the task and of the dependant it blocked.
it('vx last and vx why name a key not derived, and keep the line vx said', async () => {
  await project(`runtime: ['exit 7']`)
  const cwd = path.join(root, 'packages', 'app')
  expect((await vx('run', 'test', '--all')).code).toBe(1)
  const row = (await vx('last')).out
    .split('\n')
    .find((l) => l.endsWith('app#build  cache key not derived'))
  expect(row).toMatch(/^ +failed +— /)
  const log = await vx('last', '--log', 'app#build')
  expect({ code: log.code, out: log.out, err: log.err }).toEqual({
    code: 0,
    out: `[vx] app#build: cache key not derived: inputs.runtime probe exited 7: exit 7 (cwd: ${cwd})\n`,
    err: '',
  })
  const why = (await vx('why', 'app#build')).out.split('\n')
  const runId = why[1]!.split(/ +/)[2]
  expect(why[2]).toMatch(/^ {2}this run {2}\S+ · failed · no key$/)
  expect(why[4]).toBe(
    `  verdict   this task's cache key could not be derived, so its command never ran (\`vx last ${runId} --log app#build\` says why) — nothing to compare`,
  )
  const json = JSON.parse((await vx('why', 'app#build', '--format', 'json')).out)
  expect(json.why.thisRun.cacheHit).toBeNull()
  expect((await vx('why', 'app#test')).out).toContain(
    '  verdict   this task never ran: app#build did not pass, so it recorded no cache key — nothing to compare\n',
  )
}, 60_000)
