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

/** A run of `app#after` over a `servers` executor that answers each request as `dead` says. */
async function runOver(dead: string): Promise<{ code: number; out: string }> {
  const root = await makeWorkspace({ prefix: 'vx-carried-srv-' })
  try {
    const far = `{ executor() { return {
  name: 'far',
  capabilities: { remote: true, servers: true },
  execute: async (req) => {
    const dead = (req.servers ?? []).map((s) => ({ taskId: s.taskId, exitCode: 3, ${dead} }))
    return dead.length === 0
      ? { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
      : { exitCode: 1, durationMs: 1, stdout: '', stderr: 'srv died\\n', violations: [], deadServers: dead }
  },
} } }`
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource([pluginSource('org/far', far)]),
    )
    await addProject(root, 'app', {
      config: `export default { tasks: {
  srv: { exec: { command: 'echo up && sleep 60', persistent: { readyWhen: 'up' } } },
  use: { dependsOn: ['srv'], exec: { command: 'true' } },
  after: { dependsOn: ['use'], exec: { command: 'true' } },
} }`,
    })
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
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('a carried server that never became ready fails, and skips what needs it', async () => {
  const { code, out } = await runOver('began: false')
  expect([code, /tasks +(.*)/.exec(out)?.[1]?.trim()]).toEqual([
    1,
    '1 failed · 2 skipped · 3 total',
  ])
  expect(out).toMatch(/skipped .*app#use • blocked by app#srv/)
  // A skip shows no output: why the server died is said once, as a warning.
  expect(out.match(/\[vx\] srv died/g)).toHaveLength(1)
}, 60_000)

it('a carried server that died under its running dependant fails too', async () => {
  const { code, out } = await runOver('began: true')
  expect([code, /tasks +(.*)/.exec(out)?.[1]?.trim()]).toEqual([
    1,
    '2 failed · 1 skipped · 3 total',
  ])
}, 60_000)
