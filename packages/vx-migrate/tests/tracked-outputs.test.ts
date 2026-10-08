import { describe, expect, it } from 'bun:test'
import { spareTrackedOutputs, trackedKinds } from '../src/tracked-outputs.js'

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

describe('spareTrackedOutputs — a reader the take-back hides a committed file from (X-54)', () => {
  const reader = (files: string[]) => ({
    name: 'test',
    task: { exec: { command: 't' }, cache: { inputs: { files } } } as Record<string, unknown>,
  })
  it('uncaches the reader whose `!` hides the committed file, keeps the one without', () => {
    const writer = task({ files: ['data'] })
    const hides = reader(['**/*', '!data'])
    // CONTROL: no take-back, so the committed file stays in its key.
    const plain = reader(['src/**'])
    const todos = spareTrackedOutputs(
      '/w',
      [{ name: 'a', dir: '/w/packages/a', tasks: [writer, hides, plain] }],
      ['packages/a/data/sponsors.json'],
    )
    expect([hides.task['cache'], plain.task['cache'] !== undefined, todos]).toEqual([
      undefined,
      true,
      [
        [
          'a#test',
          "reads the committed data/sponsors.json, which its inputs take back with a#build's " +
            'outputs — task runs uncached; declare its inputs in a vx.config to cache it',
        ],
        ['a#build', expect.stringContaining('(data/sponsors.json)')],
      ],
    ])
  })
})

describe('spareTrackedOutputs — an output naming one committed file', () => {
  const reader = (inputs: Record<string, string[]>) => ({
    name: 'build',
    task: { exec: { command: 'b' }, cache: { inputs } } as Record<string, unknown>,
  })
  // hono/middleware: lint declared the committed `eslint-suppressions.json`,
  // and every build and typecheck beside it ran uncached.
  it('drops the entry and the `!` readers got for it; readers stay cached', () => {
    const lint = {
      name: 'lint',
      task: {
        exec: { command: 'eslint' },
        cache: {
          inputs: { files: ['**/*'] },
          outputs: { files: ['.cache/.eslintcache', 'eslint-suppressions.json'] },
        },
      } as Record<string, unknown>,
    }
    const build = reader({ files: ['**/*', '!eslint-suppressions.json', '!dist/**'] })
    const rootReader = reader({
      files: ['src/**'],
      workspaceFiles: ['packages/a/**', '!packages/a/eslint-suppressions.json'],
    })
    // CONTROL: another project's own file of that name stays taken back.
    const other = reader({ files: ['**/*', '!eslint-suppressions.json'] })
    const todos = spareTrackedOutputs(
      '/w',
      [
        { name: 'a', dir: '/w/packages/a', tasks: [lint, build] },
        { name: 'b', dir: '/w/packages/b', tasks: [rootReader, other] },
      ],
      ['packages/a/eslint-suppressions.json', 'packages/a/src/index.ts'],
    )
    expect([
      lint.task['cache'],
      build.task['cache'],
      rootReader.task['cache'],
      other.task['cache'],
      todos,
    ]).toEqual([
      { inputs: { files: ['**/*'] }, outputs: { files: ['.cache/.eslintcache'] } },
      { inputs: { files: ['**/*', '!dist/**'] } },
      { inputs: { files: ['src/**'], workspaceFiles: ['packages/a/**'] } },
      { inputs: { files: ['**/*', '!eslint-suppressions.json'] } },
      [],
    ])
  })
})

describe('trackedKinds', () => {
  it('reads each directory’s own files, the root’s all of them, extensions lower-cased', () => {
    const kinds = trackedKinds([
      'package.json',
      'packages/a/src/index.TS',
      'packages/a/README',
      'packages/ab/lib/pom.xml',
    ])
    const of = (rel: string) => {
      const k = kinds(rel)
      return { exts: [...k.exts].sort(), dirs: [...k.dirs].sort(), tops: [...k.tops].sort() }
    }
    expect(of('packages/a')).toEqual({ exts: ['ts'], dirs: ['src'], tops: ['README', 'src'] })
    expect(of('.')).toEqual({
      exts: ['json', 'ts', 'xml'],
      dirs: ['a', 'ab', 'lib', 'packages', 'src'],
      tops: ['package.json', 'packages'],
    })
    expect(of('')).toEqual(of('.'))
  })
})

// A project's files are found by a binary search over the sorted list
// (every project scanned all of them: 177 ms of a cold 1,000-package
// mapping). The run must hold exactly the files under `rel/`: a sibling
// whose name extends it sorts on either side of the run.
describe('trackedKinds: a project sees exactly the files under it', () => {
  it('not a sibling sharing its name, wherever the list puts it', () => {
    const tracked = [
      'packages/p10/c.css',
      'packages/p1/sub/d.js',
      'packages/p1-x/a.md',
      'packages/p1/b.ts',
      'packages/p1.old/e.yml',
      'README.txt',
    ]
    const kinds = trackedKinds(tracked)('packages/p1')
    expect([[...kinds.exts].sort(), [...kinds.tops].sort(), [...kinds.dirs].sort()]).toEqual([
      ['js', 'ts'],
      ['b.ts', 'sub'],
      ['sub'],
    ])
    expect([...trackedKinds(tracked)('').exts].sort()).toEqual([
      'css',
      'js',
      'md',
      'ts',
      'txt',
      'yml',
    ])
  })
})
