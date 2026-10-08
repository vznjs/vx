import { describe, expect, it } from 'bun:test'
import type { GeneratedTask } from '@vzn/vx'
import {
  excludeSiblingOutputs,
  excludeWorkspaceOutputs,
  resolveSharedOutputs,
  resolveSharedWorkspaceOutputs,
} from '../src/shared-outputs.js'

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

  it('uncaches a dependant too: the default rules refuse the pair edge or not (X-53)', () => {
    // twenty: build → dist, build:individual depends on build → dist/individual;
    // and strapi's chain, build:types depending on build, both on dist/**.
    const twenty = resolveSharedOutputs([
      task('build', ['dist'], ['^build']),
      task('build:individual', ['dist/individual'], ['build']),
    ])
    expect(twenty.map((t) => [t.name, t.task!['cache'] !== undefined, t.todos.length])).toEqual([
      ['build', true, 0],
      ['build:individual', false, 1],
    ])
    const strapi = resolveSharedOutputs([
      task('build', ['dist/**'], ['^build']),
      task('build:types', ['dist/**'], ['build']),
      task('build:code', ['dist/**']),
    ])
    expect(strapi.map((t) => [t.name, t.task!['cache'] !== undefined])).toEqual([
      ['build', true],
      ['build:types', false],
      ['build:code', false],
    ])
    expect(strapi[1]!.todos[0]).toEndWith('Give it its own output path to cache it.')
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

const reader = (name: string, files: string[], workspaceFiles?: string[]): GeneratedTask => ({
  name,
  todos: [],
  task: {
    exec: { command: name },
    cache: { inputs: { files, ...(workspaceFiles ? { workspaceFiles } : {}) } },
  },
})
const inputsOf = (t: GeneratedTask) =>
  (t.task!['cache'] as { inputs: Record<string, string[]> } | undefined)?.inputs

describe('excludeSiblingOutputs — no key reads a sibling output (X-54)', () => {
  it('takes back each overlapping output once, and uncaches a literal reader', () => {
    const tasks = excludeSiblingOutputs([
      task('build', ['dist/**']),
      reader('test', ['**/*', '!dist/**']),
      reader('lint', ['src/**', 'dist/index.js']),
      // CONTROL: disjoint inputs stay as they are.
      reader('fmt', ['src/**']),
    ])
    expect([
      inputsOf(tasks[0]!)?.['files'],
      inputsOf(tasks[1]!)?.['files'],
      inputsOf(tasks[2]!),
      tasks[2]!.todos,
      inputsOf(tasks[3]!)?.['files'],
    ]).toEqual([
      ['**/*'],
      ['**/*', '!dist/**'],
      undefined,
      [
        'reads "dist/index.js", which "build" writes — vx keys a task only on files no other ' +
          'task writes, so it runs uncached; read the source instead in a vx.config to cache it',
      ],
      ['src/**'],
    ])
  })

  it('a reader over the whole package gains the sibling output', () => {
    const tasks = excludeSiblingOutputs([task('build', ['dist/**']), reader('test', ['**/*'])])
    expect(inputsOf(tasks[1]!)?.['files']).toEqual(['**/*', '!dist/**'])
  })
})

describe('excludeWorkspaceOutputs — workspace inputs against every output (X-54)', () => {
  it('takes back workspace and rebased project outputs, skips its own', () => {
    const gen: GeneratedTask = {
      name: 'gen',
      todos: [],
      task: {
        exec: { command: 'gen' },
        cache: {
          inputs: { files: ['**/*'], workspaceFiles: ['tools/**'] },
          outputs: { workspaceFiles: ['tools/out/**'] },
        },
      },
    }
    const r = reader('test', ['src/**'], ['packages/**', 'tools/**', 'other/**'])
    excludeWorkspaceOutputs('/w', [
      { name: 'a', dir: '/w/packages/a', tasks: [task('build', ['dist/**'])] },
      { name: 'b', dir: '/w/packages/b', tasks: [r, gen] },
    ])
    expect([inputsOf(r)?.['workspaceFiles'], inputsOf(gen)?.['workspaceFiles']]).toEqual([
      ['packages/**', 'tools/**', 'other/**', '!packages/a/dist/**', '!tools/out/**'],
      ['tools/**'],
    ])
  })

  it('uncaches a literal workspace reader', () => {
    const r = reader('test', ['src/**'], ['packages/a/dist/index.js'])
    excludeWorkspaceOutputs('/w', [
      { name: 'a', dir: '/w/packages/a', tasks: [task('build', ['dist/**'])] },
      { name: 'b', dir: '/w/packages/b', tasks: [r] },
    ])
    expect([inputsOf(r), r.todos.length]).toEqual([undefined, 1])
  })

  // Core refuses a project's `inputs.files` over another task's workspace
  // output inside it (X-135): Turbo's `**/*` beside a codegen writing
  // `packages/lib/generated/**` from another package.
  it("takes another task's workspace output back from a project's own inputs", () => {
    const writer = (out: string): GeneratedTask => ({
      name: 'gen',
      todos: [],
      task: {
        exec: { command: 'gen' },
        cache: { inputs: { files: ['src/**'] }, outputs: { workspaceFiles: [out] } },
      },
    })
    const lib = reader('build', ['**/*'])
    const root = reader('lint', ['**/*'])
    const other = reader('test', ['src/**'])
    excludeWorkspaceOutputs('/w', [
      { name: 'app', dir: '/w/packages/app', tasks: [writer('packages/lib/generated/**')] },
      { name: 'lib', dir: '/w/packages/lib', tasks: [lib, other] },
      { name: 'root', dir: '/w', tasks: [root] },
    ])
    expect([
      inputsOf(lib)?.['files'],
      inputsOf(other)?.['files'],
      inputsOf(root)?.['files'],
    ]).toEqual([['**/*', '!generated/**'], ['src/**'], ['**/*', '!packages/lib/generated/**']])
  })

  it('uncaches a project reader of a literal an output reaches from above', () => {
    const writer: GeneratedTask = {
      name: 'gen',
      todos: [],
      task: {
        exec: { command: 'gen' },
        cache: { inputs: { files: ['src/**'] }, outputs: { workspaceFiles: ['**/gen/**'] } },
      },
    }
    const literal = reader('test', ['gen/a.ts'])
    excludeWorkspaceOutputs('/w', [
      { name: 'app', dir: '/w/packages/app', tasks: [writer] },
      { name: 'lib', dir: '/w/packages/lib', tasks: [literal] },
    ])
    expect([inputsOf(literal), literal.todos]).toEqual([
      undefined,
      [
        'reads "gen/a.ts", which app#gen writes — vx keys a task only on files no other task ' +
          'writes, so it runs uncached; read the source instead in a vx.config to cache it',
      ],
    ])
  })
})
