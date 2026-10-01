import { describe, expect, it } from 'bun:test'
import { spareTrackedOutputs, trackedExtensions } from '../src/tracked-outputs.js'

const task = (outputs: Record<string, string[]>) => ({
  name: 'build',
  task: { exec: { command: 'x' }, cache: { inputs: { files: ['**/*'] }, outputs } } as Record<
    string,
    unknown
  >,
})
const outputsOf = (t: ReturnType<typeof task>) =>
  (t.task['cache'] as { outputs: Record<string, string[]> } | undefined)?.outputs

describe('spareTrackedOutputs', () => {
  it('takes back each committed file an output covers, in either field, once', () => {
    const own = task({ files: ['data', '!data/keep.json', 'dist/**/*.js'] })
    const ws = task({ workspaceFiles: ['node_modules/.gen'] })
    const todos = spareTrackedOutputs(
      '/w',
      [
        { name: 'a', dir: '/w/packages/a', tasks: [own] },
        { name: 'b', dir: '/w/packages/b', tasks: [ws] },
      ],
      [
        'packages/a/data/sponsors.json',
        'packages/a/data/keep.json',
        'packages/a/dist/types.d.ts',
        'packages/a/src/index.ts',
        'packages/b/data/sponsors.json',
        'node_modules/.gen/seed.txt',
      ],
    )
    expect([outputsOf(own), outputsOf(ws), todos.map(([id]) => id)]).toEqual([
      // CONTROL: `keep.json` is already taken back; `types.d.ts` no glob covers.
      { files: ['data', '!data/keep.json', 'dist/**/*.js', '!data/sponsors.json'] },
      { workspaceFiles: ['node_modules/.gen', '!node_modules/.gen/seed.txt'] },
      ['a#build', 'b#build'],
    ])
  })

  // 4,200 take-backs cost typescript-eslint's warm run 1.2 s.
  it('past sixteen files the task runs uncached instead', () => {
    const at = (n: number) => {
      const t = task({ files: ['gen'] })
      const tracked = Array.from({ length: n }, (_, i) => `gen/${String(i).padStart(2, '0')}.ts`)
      const todos = spareTrackedOutputs('/w', [{ name: 'a', dir: '/w', tasks: [t] }], tracked)
      return [outputsOf(t)?.files?.length ?? 'uncached', todos[0]![1].split(' — ')[1]]
    }
    expect([at(16), at(17)]).toEqual([
      [17, 'vx cleans outputs before a run, so they are taken back with `!` and kept'],
      ['uncached', 'task runs uncached; declare the exact outputs in a vx.config to cache it'],
    ])
  })
})

describe('trackedExtensions', () => {
  it('reads each directory’s own files, the root’s all of them, lower-cased', () => {
    const exts = trackedExtensions([
      'package.json',
      'packages/a/src/index.TS',
      'packages/a/README',
      'packages/ab/pom.xml',
    ])
    expect([...exts('packages/a')].sort()).toEqual(['ts'])
    expect([...exts('.')].sort()).toEqual(['json', 'ts', 'xml'])
    expect([...exts('')].sort()).toEqual(['json', 'ts', 'xml'])
  })
})
