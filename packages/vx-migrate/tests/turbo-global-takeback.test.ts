// A task's own `!` input narrows only its own inputs in Turbo: the global
// hash (globalDependencies) is computed apart, so a task negation never
// takes a global file back, nor a global negation a task's own input.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-takeback-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function map(turbo: unknown, rootScripts: Record<string, string>) {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo))
  const rootPkg = { name: 'root', scripts: rootScripts }
  await writeFile(path.join(root, 'package.json'), JSON.stringify(rootPkg))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const aPkg = { name: 'a', scripts: { build: 'b' } }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(aPkg))
  const metas: PackageMeta[] = [
    { name: 'root', dir: root, packageJson: rootPkg as never, configPath: null },
    { name: 'a', dir, packageJson: aPkg as never, configPath: null },
  ]
  const m = await mapTurboWorkspace(root, metas, {
    splice: (_k: string, v: readonly string[]) => v,
    persistentTodo: 'PERSIST',
  })
  return (p: string, t: string) =>
    m.projects.find((x) => x.name === p)!.tasks.find((x) => x.name === t)!.task!
}

const ws = (task: Record<string, unknown>) =>
  (task['inputs'] as { workspaceFiles: string[] }).workspaceFiles

describe('a task negation and the global inputs', () => {
  it('a root task negation keeps a global dependency keyed', async () => {
    const task = await map(
      {
        globalDependencies: ['config/base.json'],
        tasks: { '//#lint': { inputs: ['**/*', '!config/**'] } },
      },
      { lint: 'oxlint' },
    )
    // Taken back by the task's own `!config/**`, the global file keyed
    // nothing and its edit replayed a stale lint.
    expect(ws(task('root', 'lint'))).toContain('config/base.json')
  })

  it('a package task $TURBO_ROOT$ negation keeps a global dependency keyed', async () => {
    const task = await map(
      {
        globalDependencies: ['config/base.json'],
        tasks: {
          build: { inputs: ['src/**', '$TURBO_ROOT$/config/*.ts', '!$TURBO_ROOT$/config/**'] },
        },
      },
      {},
    )
    expect(ws(task('a', 'build'))).toContain('config/base.json')
  })

  it('a global negation keeps a root task input keyed', async () => {
    const task = await map(
      {
        globalDependencies: ['shared/**', '!shared/README.md'],
        tasks: { '//#lint': { inputs: ['shared/README.md'] } },
      },
      { lint: 'oxlint' },
    )
    expect(ws(task('root', 'lint'))).toContain('shared/README.md')
  })
})

describe('Turbo 2.11 global.inputs', () => {
  it('joins the task inputs, so a task negation takes one back', async () => {
    // Turbo prepends `global.inputs` to each task's inputs (#12399), so
    // `!$TURBO_ROOT$/config/**` excludes it there; keyed, it cost a hit.
    const task = await map(
      {
        futureFlags: { globalConfiguration: true },
        global: { inputs: ['config/base.json', 'tsconfig.json'] },
        tasks: { '//#lint': { inputs: ['**/*', '!config/**'] }, build: {} },
      },
      { lint: 'oxlint' },
    )
    expect(ws(task('root', 'lint'))).toEqual(['**/*', '!config/**', 'tsconfig.json'])
    expect(ws(task('a', 'build'))).toEqual(['config/base.json', 'tsconfig.json'])
  })
})

describe('a preset spread of the global inputs', () => {
  it('is inlined where a global exclusion is dropped, spread elsewhere', async () => {
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({
        globalDependencies: ['shared/**', '!shared/README.md'],
        tasks: { '//#lint': { inputs: ['shared/README.md'] }, build: {} },
      }),
    )
    const rootPkg = { name: 'root', scripts: { lint: 'oxlint' } }
    await writeFile(path.join(root, 'package.json'), JSON.stringify(rootPkg))
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    const aPkg = { name: 'a', scripts: { build: 'b' } }
    await writeFile(path.join(dir, 'package.json'), JSON.stringify(aPkg))
    const spread = { raw: '...globalInputs' }
    const m = await mapTurboWorkspace(
      root,
      [
        { name: 'root', dir: root, packageJson: rootPkg as never, configPath: null },
        { name: 'a', dir, packageJson: aPkg as never, configPath: null },
      ],
      { splice: () => [spread], persistentTodo: 'PERSIST' },
    )
    const task = (p: string) => m.projects.find((x) => x.name === p)!.tasks[0]!
    expect(ws(task('root').task!)).toEqual(['shared/README.md', 'shared/**'])
    expect(task('root').uses.has('inputs')).toBe(false)
    expect(ws(task('a').task!) as unknown[]).toEqual([spread])
  })
})
