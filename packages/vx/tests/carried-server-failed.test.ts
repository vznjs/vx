// A server carried to the machine that runs its dependant (a `servers`
// executor, vx-dte's workers) that died there: its row read `success` and
// its dependant `failed`, where a run on one machine fails the server and
// skips what needs it (2026-11-23).
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

/** Runs of `app#after` over a `servers` executor that answers each request as `dead` says. */
async function runOver(dead: string, runs = 1): Promise<{ code: number; out: string }[]> {
  const root = await makeWorkspace({ prefix: 'vx-carried-srv-' })
  try {
    const far = `{ executor() { return {
  name: 'far',
  capabilities: { remote: true, servers: true },
  execute: async (req) => {
    const dead = (req.servers ?? []).map((s) => ({ taskId: s.taskId, exitCode: 3, ${dead} }))
    return dead.length === 0
      ? { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
      : { exitCode: dead[0].began ? 0 : 1, durationMs: 1, stdout: '', stderr: 'srv died\\n', violations: [], deadServers: dead }
  },
} } }`
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([pluginSource('org/far', far)]),
    )
    await addProject(root, 'app', {
      config: `export default { tasks: {
  srv: { exec: { command: 'echo up && sleep 60', persistent: { readyWhen: 'up' } }, inputs: { files: ['vx.config.mjs'] } },
  use: { dependsOn: ['srv'], exec: { command: 'true' }, inputs: { files: ['vx.config.mjs'] }, outputs: { files: [] }, cache: true },
  after: { dependsOn: ['use'], exec: { command: 'true' }, inputs: { files: ['vx.config.mjs'] }, outputs: { files: [] }, cache: true },
} }`,
    })
    const out: { code: number; out: string }[] = []
    for (let i = 0; i < runs; i++) {
      const p = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
          'run',
          'app#after',
        ],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1', CI: '' },
      })
      out.push({ code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() })
    }
    return out
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('a carried server that never became ready fails, and skips what needs it', async () => {
  const { code, out } = (await runOver('began: false'))[0]!
  expect([code, /tasks +(.*)/.exec(out)?.[1]?.trim()]).toEqual([
    1,
    '1 failed · 2 skipped · 3 total',
  ])
  expect(out).toMatch(/skipped .*app#use • blocked by app#srv/)
  // A skip shows no output: why the server died is said once, as a warning.
  expect(out.match(/\[vx\] srv died/g)).toHaveLength(1)
}, 60_000)

// As one machine does: a dependant running when its server died finishes,
// but neither it nor what builds on it is saved, so the next run runs them.
it('a carried server that died under its running dependant fails; it and what follows pass unsaved', async () => {
  const runs = await runOver('began: true', 2)
  expect(runs.map((r) => [r.code, /tasks +(.*)/.exec(r.out)?.[1]?.trim()])).toEqual([
    [1, '1 failed · 2 success · 3 total'],
    [1, '1 failed · 2 success · 3 total'],
  ])
  expect(runs.map((r) => /cache +(.*)/.exec(r.out)?.[1]?.trim())).toEqual([
    'local 1∅ · 2 not saved',
    'local 1∅ · 2 not saved',
  ])
  expect(runs[0]!.out).toContain(
    '[vx] app#srv, which app#use depends on, exited with code 3 while it ran',
  )
}, 60_000)
