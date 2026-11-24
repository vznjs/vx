// Turbo caches the outputs a run wrote and skips the rest; vx requires each
// one. A shared `build.outputs ["dist/**", ".next/**"]` failed every Vite
// package's build after migration with nothing said at migration time. An
// output that matches no file where its task's outputs match elsewhere is
// named on the task; outputs that match nothing anywhere, in one note.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { absentOutputTodo, migrateTurbo, unbuiltOutputsNote } from '../src/migrate-turbo.js'

const COVERAGE =
  "Turbo treats outputs as optional; vx fails a task that writes none of its declared outputs: drop `coverage/**` from test's outputs or run it with coverage"

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-migrate-absent-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pkg(name: string, files: Record<string, string>): Promise<PackageMeta> {
  const dir = path.join(root, 'packages', name)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), text)
  }
  const scripts = { build: 'vite build', test: 'vitest run' }
  return { name, dir, packageJson: { name, scripts } as never, configPath: null }
}

async function planOf(tasks: Record<string, unknown>, metas: PackageMeta[]) {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks }))
  return migrateTurbo(root, metas)
}

async function todos(tasks: Record<string, unknown>, metas: PackageMeta[]) {
  const plan = await planOf(tasks, metas)
  return Object.fromEntries(
    plan.projects.flatMap((p) => p.tasks.map((t) => [`${p.name}#${t.name}`, t.todos])),
  )
}

describe('migrateTurbo: outputs that match nothing now', () => {
  it('names the shared literal output each built package never wrote', async () => {
    const vite = await pkg('vite-app', { 'dist/index.js': '' })
    const next = await pkg('next-app', { '.next/BUILD_ID': '' })
    expect(
      await todos({ build: { outputs: ['dist/index.js', '.next/BUILD_ID'] } }, [vite, next]),
    ).toEqual({
      'vite-app#build': [absentOutputTodo(['.next/BUILD_ID'])],
      'next-app#build': [absentOutputTodo(['dist/index.js'])],
    })
  })

  // A wildcard may match nothing beside one that matched (M 2026-11-23):
  // Turbo's shared `["dist/**", ".next/**"]` runs every package unchanged.
  it('names no wildcard output beside one that matched', async () => {
    const vite = await pkg('vite-app', { 'dist/index.js': '' })
    const next = await pkg('next-app', { 'dist/x': '', '.next/cache/x': '' })
    expect(
      await todos({ build: { outputs: ['dist/**', '.next/**', '!.next/cache/**'] } }, [vite, next]),
    ).toEqual({ 'vite-app#build': [], 'next-app#build': [] })
  })

  it('names in one note the tasks whose outputs match nothing anywhere, not an uncached task', async () => {
    const a = await pkg('a', { 'dist/index.js': '' })
    const b = await pkg('b', {})
    const plan = await planOf(
      {
        build: { outputs: ['dist/**'] },
        test: { outputs: ['coverage/**', '.cache/.eslintcache'] },
        dev: { cache: false, outputs: ['tmp/**'] },
      },
      [a, b],
    )
    expect({
      todos: plan.projects.flatMap((p) => p.tasks.map((t) => [`${p.name}#${t.name}`, t.todos])),
      notes: plan.notes.filter((n) => n.startsWith('no package has a file')),
    }).toEqual({
      todos: [
        ['a#build', []],
        ['a#test', [COVERAGE]],
        ['a#dev', []],
        ['b#build', [absentOutputTodo(['dist/**'])]],
        ['b#test', [COVERAGE]],
        ['b#dev', []],
      ],
      // A coverage output is named on each task, not again in the note.
      notes: [unbuiltOutputsNote(new Map([['test', ['.cache/.eslintcache']]]))],
    })
  })

  it('reads a workspace output from the workspace root', async () => {
    const a = await pkg('a', {})
    await mkdir(path.join(root, 'out'), { recursive: true })
    await writeFile(path.join(root, 'out', 'a.txt'), '')
    expect(
      await todos({ build: { outputs: ['$TURBO_ROOT$/out/a.txt', '$TURBO_ROOT$/gone.txt'] } }, [a]),
    ).toEqual({ 'a#build': [absentOutputTodo(['gone.txt'])] })
  })

  it('says one output or many', () => {
    expect(absentOutputTodo(['dist/**'])).toStartWith('output "dist/**" matches no file here')
    expect(absentOutputTodo(['a', 'b'])).toStartWith('outputs "a", "b" match no file')
    expect(unbuiltOutputsNote(new Map([['build', ['dist/**']]]))).toStartWith(
      'no package has a file the outputs of build ("dist/**") match yet',
    )
  })
})

describe('migrateTurbo: a committed output is no sign a run wrote it', () => {
  it('names nothing per task when only a committed file matches', async () => {
    // shadcn/ui commits apps/v4/public/r/styles: a fresh clone's packages
    // were all named against it, as if the others had been built.
    const a = await pkg('a', { 'styles/x.json': '' })
    const b = await pkg('b', {})
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', ...args], {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      })
    git('init', '-q')
    git('add', '-A')
    const plan = await planOf({ build: { outputs: ['dist/index.js', 'styles/x.json'] } }, [a, b])
    expect({
      todos: plan.projects.flatMap((p) => p.tasks.map((t) => [`${p.name}#${t.name}`, t.todos])),
      notes: plan.notes.filter((n) => n.startsWith('no package has a file')),
    }).toEqual({
      todos: [
        ['a#build', []],
        ['b#build', []],
      ],
      notes: [unbuiltOutputsNote(new Map([['build', ['dist/index.js', 'styles/x.json']]]))],
    })
  })
})
