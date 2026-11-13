// An executor with `capabilities.dependencyOutputs` lists a sandboxed
// task's dependencies' outputs on the machine that runs it: its request
// names the dependencies (`sandbox.readableDeps`) and this machine walks
// none of their files, so a dependant is sent before they are here.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

for (const there of [true, false]) {
  it(
    there
      ? 'hands a dependencyOutputs executor the dependencies, not their files'
      : 'CONTROL: without it, the files are listed here',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-deps-there-' })
      try {
        // Its `node` writes the output as a worker's restore would; its
        // `use` records the sandbox it was handed.
        const far = `{ executor() { return {
  name: 'far',
  capabilities: { remote: true, sandbox: true${there ? ', dependencyOutputs: true' : ''} },
  execute: async (req) => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    if (req.taskId.endsWith('#node')) {
      mkdirSync(req.cwd + '/out', { recursive: true })
      writeFileSync(req.cwd + '/out/t.txt', 'T')
    } else
      writeFileSync(${JSON.stringify(path.join(root, 'seen.json'))}, JSON.stringify({
        deps: req.sandbox?.readableDeps ?? null,
        reads: req.sandbox?.dependencyReads ?? [],
      }))
    return { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
  },
} } }`
        await Bun.write(
          path.join(root, '.vx/workspace.mjs'),
          localWorkspaceSource([pluginSource('org/far', far)]),
        )
        await addProject(root, 'tools', {
          config: `export default { tasks: { node: { exec: { command: 'true' }, outputs: { files: ['out/**'] } } } }`,
        })
        await addProject(root, 'app', {
          config: `export default { tasks: { use: { exec: { command: 'true', sandbox: {} }, dependsOn: ['tools#node'] } } }`,
        })
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
            'run',
            'use',
            '--all',
          ],
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', CI: '' },
        })
        expect([p.exitCode, p.stdout.toString() + p.stderr.toString()]).toEqual([
          0,
          expect.any(String),
        ])
        const seen = (await Bun.file(path.join(root, 'seen.json')).json()) as {
          deps: { taskId: string; projectDir: string; outputs: unknown }[] | null
          reads: string[]
        }
        const rel = (f: string) => path.relative(root, f)
        expect({
          deps: seen.deps?.map((d) => ({ ...d, projectDir: rel(d.projectDir) })) ?? null,
          reads: seen.reads.map(rel),
        }).toEqual(
          there
            ? {
                deps: [
                  {
                    taskId: 'tools#node',
                    projectDir: path.join('packages', 'tools'),
                    outputs: { files: ['out/**'], workspaceFiles: [] },
                  },
                ],
                reads: [],
              }
            : { deps: null, reads: [path.join('packages', 'tools', 'out')] },
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
}
