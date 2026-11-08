// Turbo cleans `.` and `..` out of a glob before it walks (turborepo-globwalk's
// `collapse_path`), so `./../shared/**` and `src/../../shared/**` are
// `../shared/**`. Read as written, they fell through to core, which
// refuses a `..` segment, and the whole `vx lock` failed.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

const mapTask = async (task: object) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-dots-'))
  try {
    await writeFile(path.join(dir, 'turbo.json'), JSON.stringify({ tasks: { t: task } }))
    const meta: PackageMeta = {
      name: 'app',
      dir: path.join(dir, 'packages', 'app'),
      packageJson: { name: 'app', scripts: { t: 'echo t' } } as never,
      configPath: null,
    }
    const m = await mapTurboWorkspace(dir, [meta], {
      splice: (_k, v) => v,
      persistentTodo: 'PERSIST',
    })
    const t = m.projects[0]!.tasks[0]!
    return { todos: t.todos, task: t.task as Record<string, Record<string, unknown>> }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('turbo-map: `.` and `..` segments in a glob', () => {
  it('maps an input that climbs through them as its clean spelling', async () => {
    const dotted = await mapTask({
      inputs: ['./../shared/**', 'src/../../lib/*.ts', '!./../shared/skip/**'],
    })
    expect(dotted.todos).toEqual([])
    expect(dotted.task.inputs!['workspaceFiles']).toEqual(
      (await mapTask({ inputs: ['../shared/**', '../lib/*.ts', '!../shared/skip/**'] })).task
        .inputs!['workspaceFiles'],
    )
  })

  it('maps an output that climbs through them as its clean spelling', async () => {
    const dotted = await mapTask({ outputs: ['./../out/**', 'dist/../../gen/**'] })
    expect(dotted.todos).toEqual([])
    expect(dotted.task.outputs!['workspaceFiles']).toEqual(
      (await mapTask({ outputs: ['../out/**', '../gen/**'] })).task.outputs!['workspaceFiles'],
    )
  })
})
