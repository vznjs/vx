// A `sandbox` executor enforces a task's sandbox where it runs it, so the
// machine that only places the task arms none: a distributed run's
// orchestrator needs no bwrap (owner, 2026-10-22). Unsafe: it strips PATH
// of the runtime's binaries for a child vx.
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const RESULT = `{ exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }`

for (const remote of [true, false]) {
  it.skipIf(process.platform !== 'linux')(
    remote
      ? 'a sandboxed task on a sandbox executor needs no sandbox here'
      : 'CONTROL: on this machine, a missing sandbox fails it',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-remote-arm-' })
      const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-remote-arm-bin-'))
      try {
        await Bun.write(
          path.join(root, '.vx/workspace.mjs'),
          localWorkspaceSource(
            remote
              ? [
                  pluginSource(
                    'org/far',
                    `{ executor() { return { name: 'far', remote: true, sandbox: true, execute: async () => (${RESULT}) } } }`,
                  ),
                ]
              : [],
          ),
        )
        await addProject(root, 'app', {
          config: `export default { tasks: { boxed: { exec: { command: 'true', sandbox: {} } } } }`,
        })
        await symlink(process.execPath, path.join(bin, 'bun'))
        for (const name of ['sh', 'git']) await symlink(Bun.which(name)!, path.join(bin, name))
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
            'run',
            'boxed',
            '--all',
          ],
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', CI: '', PATH: bin },
        })
        const text = p.stdout.toString() + p.stderr.toString()
        expect([p.exitCode, text.includes('sandbox not available')]).toEqual(
          remote ? [0, false] : [1, true],
        )
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(bin, { recursive: true, force: true })
      }
    },
    30_000,
  )
}
