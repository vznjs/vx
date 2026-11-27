// What the mapper writes, core must load: one value core refuses fails the
// whole project, every task with it (found by a mapper fuzz).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'
import { mapNxOutputs, nxDefaultOutputs } from '../src/nx/nx-outputs.js'

// Nx drops an output that interpolates to nothing, and reads an empty
// `outputPath` as unset (`getOutputsForTargetAndConfiguration`). Mapped as
// the path `.`, core refused it.
it('an empty output is no output', () => {
  for (const rel of ['libs/a', '.']) {
    const todos: string[] = []
    expect(mapNxOutputs(['', '{workspaceRoot}/dist/x'], {}, rel, 'a', todos)).toEqual({
      outFiles: [],
      wsOutFiles: ['dist/x'],
    })
    expect(todos).toEqual([])
  }
})

it('an empty outputPath is no outputPath', () => {
  expect(nxDefaultOutputs('test', { outputPath: '' }, 'libs/a', [])).toEqual([])
  expect(nxDefaultOutputs('build', { outputPath: '' }, 'libs/a', [], new Set())).toEqual(
    nxDefaultOutputs('build', {}, 'libs/a', [], new Set()),
  )
})

// sh drops a name like `A-B` before the command runs; core refuses it, and
// an empty `{ env }` input, which Nx keys as nothing.
it('a run-commands env name sh cannot carry is left out with a todo, an empty env input dropped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vx-nx-env-'))
  try {
    const dir = path.join(root, 'a')
    await mkdir(dir)
    await writeFile(path.join(dir, 'package.json'), '{"name":"a"}')
    const graph = {
      nodes: {
        a: {
          data: {
            root: 'a',
            targets: {
              t: {
                executor: 'nx:run-commands',
                options: { command: 'echo hi', env: { OK: '1', 'A-B': '2' } },
                inputs: [{ env: '' }, { env: 'X' }],
              },
            },
          },
        },
      },
      dependencies: {},
    }
    const m = await mapNxWorkspace(
      root,
      [{ name: 'a', dir, packageJson: { name: 'a' } as never, configPath: null }],
      graph as NxGraph,
      { cacheable: new Set() },
    )
    const t = m.projects[0]!.tasks.find((x) => x.name === 't')!
    expect((t.task!['exec'] as { env: unknown }).env).toEqual({ define: { OK: '1' } })
    expect((t.task!['inputs'] as { env: unknown }).env).toEqual(['X'])
    expect(t.todos).toContain('nx:run-commands: `env.A-B` is not a shell variable name — not set')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('an output that is the whole workspace is the root project, else dropped with a todo', () => {
  const todos: string[] = []
  expect(mapNxOutputs(['./', 'dist'], {}, 'libs/a', 'a', todos)).toEqual({
    outFiles: [],
    wsOutFiles: ['dist'],
  })
  expect(todos).toEqual(['output "./" is the whole workspace — vx caches no such output; dropped'])
  expect(mapNxOutputs(['.'], {}, '.', 'a', todos).outFiles).toEqual(['*', '*/**'])
})
