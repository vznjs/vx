// What the Vite Task mapper writes, `vx lock` must load (found by a mapper
// fuzz): a name sh cannot carry in passThrough, a workspace glob that leaves
// the workspace, an empty pattern and a bare `.` were written as core
// refuses them, and the written config failed to load.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { mapViteTaskWorkspace } from '../src/vite-task/vite-task-map.js'

it('each task loads, what does not map is a todo', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-vtload-'))
  try {
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(root, 'package.json'), '{"name":"ws"}')
    await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
    const ws = (pattern: string) => ({ pattern, base: 'workspace' })
    const tasks = {
      env: { command: 'x', cache: { untrackedEnv: ['A-B', 'OK'] } },
      out: { command: 'x', cache: { input: ['src/**', ws('../out')], output: [] } },
      empty: { command: 'x', cache: { input: ['src/**', ''], output: [] } },
      dot: { command: 'x', cache: { input: ['.'], output: [] } },
    }
    await writeFile(
      path.join(dir, 'vite.config.ts'),
      `export default { run: { tasks: ${JSON.stringify(tasks)} } }`,
    )
    const m = await mapViteTaskWorkspace(root, [
      { name: 'a', dir, packageJson: { name: 'a' } as never, configPath: null },
    ])
    const p = m.projects.find((x) => x.name === 'a')!
    const config = Object.fromEntries(p.tasks.map((t) => [t.name, t.task]))
    const json = JSON.stringify(config)
    for (const refused of ['"A-B"', '"../out"', '""', '"."']) expect(json).not.toContain(refused)
    expect((config['env'] as { exec: unknown }).exec).toEqual({
      command: 'x',
      env: { passThrough: ['OK'] },
    })
    const todos = Object.fromEntries(p.tasks.map((t) => [t.name, t.todos]))
    expect(todos['env']).toContain(
      'cache.untrackedEnv "A-B": a vx env name is letters, digits and _, with * the one wildcard — list the names the task reads',
    )
    expect(todos['out']).toContain('input "../out": leaves the workspace — map manually')
    expect(todos['empty']).toContain('input "": names no file — dropped')
    expect(todos['dot']).toContain(
      'input ".": names a directory, not its files — widened to every file under it',
    )
    expect((config['dot'] as { inputs: { files: string[] } }).inputs.files).toContain('**/*')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
