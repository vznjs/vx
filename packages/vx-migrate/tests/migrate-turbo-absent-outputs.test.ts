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
  it('names the shared output each built package never wrote', async () => {
    const vite = await pkg('vite-app', { 'dist/index.js': '' })
    const next = await pkg('next-app', { '.next/BUILD_ID': '' })
    expect(
      await todos({ build: { outputs: ['dist/**', '.next/**', '!.next/cache/**'] } }, [vite, next]),
    ).toEqual({
      'vite-app#build': [absentOutputTodo(['.next/**'])],
      'next-app#build': [absentOutputTodo(['dist/**'])],
    })
  })

  it('counts a file a `!` output takes back as absent', async () => {
    const vite = await pkg('vite-app', { 'dist/index.js': '' })
    const next = await pkg('next-app', { 'dist/x': '', '.next/cache/x': '' })
    expect(
      await todos({ build: { outputs: ['dist/**', '.next/**', '!.next/cache/**'] } }, [vite, next]),
    ).toEqual({
      'vite-app#build': [absentOutputTodo(['.next/**'])],
      'next-app#build': [absentOutputTodo(['.next/**'])],
    })
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
        ['a#test', []],
        ['a#dev', []],
        ['b#build', [absentOutputTodo(['dist/**'])]],
        ['b#test', []],
        ['b#dev', []],
      ],
      notes: [unbuiltOutputsNote(new Map([['test', ['.cache/.eslintcache', 'coverage/**']]]))],
    })
  })

  it('reads a workspace output from the workspace root', async () => {
    const a = await pkg('a', {})
    await mkdir(path.join(root, 'out'), { recursive: true })
    await writeFile(path.join(root, 'out', 'a.txt'), '')
    expect(
      await todos({ build: { outputs: ['$TURBO_ROOT$/out/**', '$TURBO_ROOT$/gone/**'] } }, [a]),
    ).toEqual({ 'a#build': [absentOutputTodo(['gone/**'])] })
  })

  it('says one output or many', () => {
    expect(absentOutputTodo(['dist/**'])).toStartWith('output "dist/**" matches no file here')
    expect(absentOutputTodo(['a', 'b'])).toStartWith('outputs "a", "b" match no file')
    expect(unbuiltOutputsNote(new Map([['build', ['dist/**']]]))).toStartWith(
      'no package has a file the outputs of build ("dist/**") match yet',
    )
  })
})
