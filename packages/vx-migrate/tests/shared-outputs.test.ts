import { describe, expect, it } from 'bun:test'
import type { GeneratedTask } from '@vzn/vx'
import { resolveSharedOutputs } from '../src/shared-outputs.js'

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

  it('ignores tasks with no cache, no outputs or no representation', () => {
    const bare: GeneratedTask = { name: 'x', todos: [], task: { exec: { command: 'x' } } }
    const skipped: GeneratedTask = { name: 'y', todos: ['no shell equivalent'], task: null }
    const tasks = resolveSharedOutputs([bare, skipped, task('z', ['dist/**'])])
    expect(tasks[2]!.task!['cache']).toBeDefined()
    expect(bare.todos).toEqual([])
  })
})
