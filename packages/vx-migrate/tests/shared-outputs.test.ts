import { describe, expect, it } from 'bun:test'
import type { GeneratedTask } from '@vzn/vx'
import { resolveSharedOutputs, resolveSharedWorkspaceOutputs } from '../src/shared-outputs.js'

function task(name: string, outputs: string[], dependsOn: string[] = []): GeneratedTask {
  return {
    name,
    todos: [],
    task: {
      exec: { command: name },
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      cache: { inputs: { files: ['**/*'] }, outputs: { files: outputs } },
    },
  }
}

describe('resolveSharedOutputs — two targets on one output path', () => {
  it('keeps the cache on the task with a ^ edge and uncaches the siblings with a todo', () => {
    // strapi, 2026-09-11: build, build:code and build:types all on dist/**.
    const tasks = resolveSharedOutputs([
      task('build:code', ['dist/**']),
      task('build:types', ['dist/**']),
      task('build', ['dist/**'], ['^build']),
    ])
    expect(tasks[2]!.task!['cache']).toBeDefined()
    expect(tasks[2]!.todos).toEqual([])
    for (const t of [tasks[0]!, tasks[1]!]) {
      expect(t.task!['cache']).toBeUndefined()
      expect(t.todos).toHaveLength(1)
      expect(t.todos[0]).toContain('"dist/**"')
      expect(t.todos[0]).toContain('"build" also declares')
      expect(t.todos[0]).toContain('runs uncached')
    }
  })

  it('keeps a dependant cached: an edge orders the pair, and core caches what it adds (item 588)', () => {
    // twenty: build → dist, build:individual depends on build → dist/individual;
    // and strapi's chain, build:types depending on build, both on dist/**.
    const twenty = resolveSharedOutputs([
      task('build', ['dist'], ['^build']),
      task('build:individual', ['dist/individual'], ['build']),
    ])
    expect(twenty.map((t) => [t.name, t.task!['cache'] !== undefined, t.todos.length])).toEqual([
      ['build', true, 0],
      ['build:individual', true, 0],
    ])
    const strapi = resolveSharedOutputs([
      task('build', ['dist/**'], ['^build']),
      task('build:types', ['dist/**'], ['build']),
      task('build:code', ['dist/**']),
    ])
    expect(strapi.map((t) => [t.name, t.task!['cache'] !== undefined])).toEqual([
      ['build', true],
      ['build:types', true],
      ['build:code', false],
    ])
    expect(strapi[2]!.todos[0]).toContain('or a dependsOn edge on "build"')
    // The edge is read through a hop, and in either direction.
    const hop = resolveSharedOutputs([
      task('types', ['dist/**'], ['mid']),
      { name: 'mid', todos: [], task: { dependsOn: ['build'] } },
      task('build', ['dist/**'], ['^build']),
    ])
    expect(hop[0]!.task!['cache']).toBeDefined()
  })

  it('keeps the first declared when no task has a ^ edge', () => {
    const tasks = resolveSharedOutputs([task('a', ['out/**']), task('b', ['out/**'])])
    expect(tasks[0]!.task!['cache']).toBeDefined()
    expect(tasks[1]!.task!['cache']).toBeUndefined()
  })

  it("leaves distinct paths alone, the loader's own conservative test", () => {
    // `dist/vx-*` and `dist/other.txt` share a prefix and match disjoint
    // sets; a literal a glob matches is an overlap.
    const tasks = resolveSharedOutputs([
      task('a', ['dist/vx-*']),
      task('b', ['dist/other.txt']),
      task('c', ['lib/**']),
      task('d', ['lib/index.js']),
    ])
    expect(tasks[0]!.task!['cache']).toBeDefined()
    expect(tasks[1]!.task!['cache']).toBeDefined()
    expect(tasks[2]!.task!['cache']).toBeDefined()
    expect(tasks[3]!.task!['cache']).toBeUndefined()
  })

  it('sees every overlap the LOADER sees, because it asks the loader’s own rule', () => {
    // The gap this file had while it carried a copy of core's function:
    // each pair below is refused by `buildTaskGraph`, and each was missed
    // here, so the migration wrote a config that would not load. The
    // second pair is the commonest turbo.json shape there is —
    // `"outputs": ["dist"]` — against a sibling target's file.
    const pairs: [string, string][] = [
      ['./dist/**', 'dist/**'],
      ['dist', 'dist/app.js'],
      ['dist//**', 'dist/**'],
      ['dist/', 'dist/sub/x.txt'],
    ]
    for (const [a, b] of pairs) {
      const tasks = resolveSharedOutputs([task('one', [a]), task('two', [b])])
      expect([a, b, tasks[1]!.task!['cache']]).toEqual([a, b, undefined])
      expect([a, b, tasks[0]!.task!['cache'] !== undefined]).toEqual([a, b, true])
    }
  })

  it('CONTROL: distinct trees stay cached however they are spelled', () => {
    // Folding the spelling must not make disjoint paths overlap, or the
    // row above would pass by uncaching everything — and an over-eager
    // migration silently drops caching a repo was entitled to.
    for (const [a, b] of [
      ['./dist/**', 'build/**'],
      ['dist', 'distant/app.js'],
      ['dist/a', 'dist/b'],
    ] as [string, string][]) {
      const tasks = resolveSharedOutputs([task('one', [a]), task('two', [b])])
      expect([a, b, tasks[0]!.task!['cache'] !== undefined]).toEqual([a, b, true])
      expect([a, b, tasks[1]!.task!['cache'] !== undefined]).toEqual([a, b, true])
    }
  })

  it('ignores tasks with no cache, no outputs or no representation', () => {
    const bare: GeneratedTask = { name: 'x', todos: [], task: { exec: { command: 'x' } } }
    const skipped: GeneratedTask = { name: 'y', todos: ['no shell equivalent'], task: null }
    const tasks = resolveSharedOutputs([bare, skipped, task('z', ['dist/**'])])
    expect(tasks[2]!.task!['cache']).toBeDefined()
    expect(bare.todos).toEqual([])
  })
})

// Each task's outputs are looked up only along its literal prefix's chain
// (every pair was compared: 1,000 packages took 9 s to map). Each row is a
// path a clash can take through that index; a missed candidate is a pair
// left cached on one path.
describe('resolveSharedWorkspaceOutputs — the clashes the prefix index finds', () => {
  const ws = (name: string, outputs: string[]): GeneratedTask => ({
    name,
    todos: [],
    task: {
      exec: { command: name },
      cache: { inputs: { files: ['**/*'] }, outputs: { files: [], workspaceFiles: outputs } },
    },
  })
  const clashes = (projects: { name: string; tasks: GeneratedTask[] }[]): string[] => {
    const all = projects.map((p) => ({ ...p, dir: `/r/packages/${p.name}` }))
    resolveSharedWorkspaceOutputs('/r', all)
    return all.flatMap((p) =>
      p.tasks.filter((t) => t.task!['cache'] === undefined).map((t) => `${p.name}#${t.name}`),
    )
  }
  it.each([
    // A later glob under a kept one's subtree, and the reverse.
    [[ws('w', ['packages/b/**'])], [task('build', ['dist/**'])], ['b#build']],
    [[task('build', ['dist/**'])], [ws('w', ['packages/a/**'])], ['b#w']],
    [[ws('w', ['packages/b/dist/**'])], [task('build', ['**'])], ['b#build']],
    // No literal prefix: every kept glob is a candidate, and a kept one is
    // one for every later glob (it matches the literal output).
    [[ws('w', ['**/dist/**'])], [ws('w', ['**/dist/**'])], ['b#w']],
    [[ws('w', ['**/out.txt'])], [task('gen', ['out.txt'])], ['b#gen']],
    // A brace ends the prefix where it starts.
    [[ws('w', ['packages/{a,b}/out/**'])], [ws('w', ['packages/{a,b}/out/**'])], ['b#w']],
    // Controls: siblings never clash, however many.
    [[task('build', ['dist/**'])], [task('build', ['dist/**'])], []],
    [[ws('w', ['packages/a/dist/**'])], [ws('w', ['packages/b/dist/**'])], []],
  ])('%#', (a, b, expected) => {
    expect(
      clashes([
        { name: 'a', tasks: a },
        { name: 'b', tasks: b },
      ]),
    ).toEqual(expected)
  })
})
