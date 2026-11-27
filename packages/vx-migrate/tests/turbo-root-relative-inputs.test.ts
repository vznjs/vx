// A root-relative input that is the workspace root or leaves it was written
// as `.` or `../x` in inputs.workspaceFiles, which core refuses: the
// project failed to load, every task with it (found by a mapper fuzz).
// Turbo 2.11.13 reads `$TURBO_ROOT$/` and a `.` globalDependency as every
// file, and matches nothing outside the workspace or at a bare `!`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { notTurbos, ownSplice } from './helpers/turbo-own.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-root-in-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function map(turbo: unknown, atRoot = false) {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo))
  const dir = atRoot ? root : path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const m = await mapTurboWorkspace(
    root,
    [
      {
        name: 'a',
        dir,
        packageJson: { name: 'a', scripts: { build: 'x' } } as never,
        configPath: null,
      },
    ],
    { splice: ownSplice, persistentTodo: 'P' },
  )
  const t = m.projects[0]!.tasks[0]!
  const inputs = t.task!['inputs'] as { workspaceFiles?: unknown[] }
  return { ws: notTurbos(inputs.workspaceFiles ?? []), todos: t.todos, notes: m.notes }
}

it('$TURBO_ROOT$/ and an input climbing to the root are every workspace file', async () => {
  for (const input of ['$TURBO_ROOT$/', '$TURBO_ROOT$/.', '../..'])
    expect((await map({ tasks: { build: { inputs: [input] } } })).ws).toEqual(['**/*'])
})

it('an input that leaves the workspace is a todo', async () => {
  for (const [input, atRoot] of [
    ['$TURBO_ROOT$/../out', false],
    ['..', true],
  ] as const) {
    const r = await map({ tasks: { build: { inputs: [input] } } }, atRoot)
    expect(r.ws.filter((g) => g !== 'package.json')).toEqual([])
    expect(r.todos).toEqual([`input ${JSON.stringify(input)}: leaves the workspace — map manually`])
  }
})

it('a globalDependency of the root is every file; one outside, or a bare !, is dropped with a note', async () => {
  const r = await map({
    globalDependencies: ['.', '../shared/**', '!', '!$TURBO_ROOT$/x'],
    tasks: { build: {} },
  })
  expect(r.ws).toEqual(['**/*'])
  for (const d of ['../shared/**', '!', '!$TURBO_ROOT$/x'])
    expect(r.notes).toContain(
      `globalDependencies ${JSON.stringify(d)} matches no workspace file in Turbo — dropped`,
    )
})

it('a $TURBO_ROOT$ globalDependency is refused, as Turbo refuses it', async () => {
  const err = await map({
    globalDependencies: ['$TURBO_ROOT$/tsconfig.json'],
    tasks: { build: {} },
  }).catch((e: Error) => e.message)
  expect(err).toBe(
    'turbo.json: globalDependencies holds "$TURBO_ROOT$/tsconfig.json": Turbo refuses a "$" entry there — its paths are root-relative already',
  )
})
