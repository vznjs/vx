// A `!` entry in `cache.outputs` takes a path back from the outputs (A-44):
// lit's wireit scripts exclude a tracked file and a scratch dir from 12
// outputs, and core refused the `!`, so they ran uncached. A taken-back
// path is not cleaned before a run or a restore, not saved, not accepted
// from a remote, not hidden from `vx watch` — and it stays an input, so an
// edit to it moves the key.
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { packArtifactBytes, planArtifact } from '../src/cache/archive.js'
import { Cache, type RemoteCacheLayer } from '../src/cache/index.js'
import { makeWatchIgnore } from '../src/cli/watch-filter.js'
import { run } from '../src/orchestrator/index.js'

const BUILD = `export default { tasks: { build: {
  exec: { command: 'mkdir -p dist/sub && cp src/a.txt dist/a.js && echo g > dist/sub/gen.js && echo t > dist/scratch.tmp' },
  cache: {
    inputs: { files: ['src/**', 'dist/keep.txt'] },
    outputs: { files: ['dist/**', '!dist/keep.txt', '!dist/sub/fixture.txt', '!**/*.tmp'] },
  },
} } }`

let fx: Fixture
let app: string
beforeEach(async () => {
  fx = await makeWorkspace('vx-neg-')
  app = await addProject(fx.root, 'app', {
    files: { 'src/a.txt': 'A1', 'dist/keep.txt': 'K1', 'dist/sub/fixture.txt': 'F1' },
    config: BUILD,
  })
})
afterEach(async () => {
  await rm(fx.root, { recursive: true, force: true })
})

const build = async (tasks = ['build']) => {
  const r = await run({ cwd: fx.root, tasks, log: silentLogger(fx) })
  return Object.fromEntries(r.outcomes.map((o) => [o.node.id, o]))
}
/** The addition shape loads only with `rules.exclusiveOutputs` off (X-53). */
const additive = () =>
  writeFile(
    path.join(fx.root, 'vx.workspace.mjs'),
    'export default { rules: { exclusiveOutputs: false } }\n',
  )
const read = (rel: string): string => readFileSync(path.join(app, rel), 'utf8')
/** The paths an entry recorded, as the index holds them. */
const rowsOf = (hash: string): string[] => {
  const cache = new Cache(path.join(fx.root, '.vx', 'cache'))
  try {
    return (cache.loadOutputFilesBatch([hash]).get(hash) ?? []).map((r) => r.path).sort()
  } finally {
    cache.close()
  }
}

describe('a negated output', () => {
  it(
    'is left in place by a miss and kept out of the entry',
    async () => {
      const o = (await build())['app#build']!
      expect(o.status).toBe('success')
      expect([read('dist/keep.txt'), read('dist/sub/fixture.txt')]).toEqual(['K1', 'F1'])
      expect(rowsOf(o.hash!)).toEqual(['dist/a.js', 'dist/sub/gen.js'])
    },
    TIMEOUT,
  )

  it(
    'is left in place by a hit, which restores the rest',
    async () => {
      await build()
      await rm(path.join(app, 'dist', 'a.js'))
      await rm(path.join(app, 'dist', 'sub', 'gen.js'))
      await writeFile(path.join(app, 'dist', 'sub', 'fixture.txt'), 'F2')
      const o = (await build())['app#build']!
      expect(o.status).toBe('cache-hit')
      expect([read('dist/a.js'), read('dist/sub/gen.js')]).toEqual(['A1', 'g\n'])
      // Not cleaned, not overwritten, and its directory not pruned.
      expect([read('dist/sub/fixture.txt'), read('dist/keep.txt')]).toEqual(['F2', 'K1'])
    },
    TIMEOUT,
  )

  it(
    "keeps the warm hit's directory snapshot, and a stray still forces the restore",
    async () => {
      await build()
      // Aged past the racy window, so the next hit records the directories.
      const old = new Date(Date.now() - 60_000)
      for (const d of ['dist', 'dist/sub']) utimesSync(path.join(app, d), old, old)
      const hit = (await build())['app#build']!
      expect(hit.status).toBe('cache-hit')
      const cache = new Cache(path.join(fx.root, '.vx', 'cache'))
      try {
        const rows = (await cache.getMany([hit.hash!])).get(hit.hash!)?.outputDirRows
        expect(rows?.map((d) => d.path).sort()).toEqual(['dist', 'dist/sub'])
      } finally {
        cache.close()
      }
      await writeFile(path.join(app, 'dist', 'stray.js'), 'x')
      expect((await build())['app#build']!.status).toBe('cache-hit')
      expect([existsSync(path.join(app, 'dist', 'stray.js')), read('dist/keep.txt')]).toEqual([
        false,
        'K1',
      ])
    },
    TIMEOUT,
  )

  it(
    'stays an input: an edit to it runs the task again',
    async () => {
      await build()
      // Control: nothing moved, a hit.
      expect((await build())['app#build']!.status).toBe('cache-hit')
      await writeFile(path.join(app, 'dist', 'keep.txt'), 'K2')
      expect((await build())['app#build']!.status).toBe('success')
    },
    TIMEOUT,
  )

  it(
    "keeps a dependant's scratch file out of its entry in the addition shape",
    async () => {
      await additive()
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.js' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**', '!dist/keep.txt', '!dist/sub/**'] } },
          },
          types: {
            dependsOn: ['build'],
            exec: { command: 'echo d > dist/a.d.ts && echo t > dist/types.tmp' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**', '!dist/keep.txt', '!dist/sub/**', '!**/*.tmp'] } },
          },
        } }`,
      )
      const o = await build(['types'])
      expect([o['app#build']!.status, o['app#types']!.status]).toEqual(['success', 'success'])
      expect(rowsOf(o['app#types']!.hash!)).toEqual(['dist/a.d.ts'])
      expect(read('dist/keep.txt')).toBe('K1')
    },
    TIMEOUT,
  )
})

describe('a negated output in the task graph', () => {
  it(
    'separates nothing: two tasks with disjoint outputs, each taking a path back, both run',
    async () => {
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: {
          a: {
            exec: { command: 'mkdir -p dist && echo a > dist/a.js' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**', '!dist/keep.txt'] } },
          },
          b: {
            exec: { command: 'mkdir -p out && echo b > out/b.js' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**', '!out/keep.txt'] } },
          },
        } }`,
      )
      const o = await build(['a', 'b'])
      expect([o['app#a']?.status, o['app#b']?.status]).toEqual(['success', 'success'])
    },
    TIMEOUT,
  )

  it(
    "leaves a narrower dependant's negation out of what the upstream counts as its additions",
    async () => {
      await additive()
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: {
          build: {
            exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.js' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**', '!dist/keep.txt', '!dist/sub/**'] } },
          },
          types: {
            dependsOn: ['build'],
            exec: { command: 'mkdir -p dist/types && echo d > dist/types/a.d.ts' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/types/**', '!dist/types/*.tmp'] } },
          },
        } }`,
      )
      await build(['types'])
      // A stray in build's tree that is no addition of types': build's hit
      // finds its tree not current and restores, which takes the stray. Read
      // as a glob, types' `!dist/types/*.tmp` matched it as an addition and
      // the stray survived the hit.
      await writeFile(path.join(app, 'dist', 'stray.js'), 'x')
      const o = await build(['types'])
      expect([
        o['app#build']!.status,
        o['app#types']!.status,
        existsSync(path.join(app, 'dist', 'stray.js')),
      ]).toEqual(['cache-hit', 'cache-hit', false])
    },
    TIMEOUT,
  )
})

describe('a negated workspace output', () => {
  beforeEach(async () => {
    await Bun.write(path.join(fx.root, 'gen', 'keep.txt'), 'W1')
    await writeFile(
      path.join(app, 'vx.config.mjs'),
      `export default { tasks: { build: {
        exec: { command: 'mkdir -p ../../gen && cp src/a.txt ../../gen/x.txt' },
        cache: {
          inputs: { files: ['src/**'], workspaceFiles: ['gen/keep.txt'] },
          outputs: { files: [], workspaceFiles: ['gen/**', '!gen/keep.txt'] },
        },
      } } }`,
    )
  })

  it(
    'is left in place, kept out of the entry, and stays an input',
    async () => {
      const o = (await build())['app#build']!
      expect(o.status).toBe('success')
      expect(readFileSync(path.join(fx.root, 'gen', 'keep.txt'), 'utf8')).toBe('W1')
      expect(rowsOf(o.hash!)).toEqual(['workspace-outputs/gen/x.txt'])
      expect((await build())['app#build']!.status).toBe('cache-hit')
      await writeFile(path.join(fx.root, 'gen', 'keep.txt'), 'W2')
      expect((await build())['app#build']!.status).toBe('success')
    },
    TIMEOUT,
  )
})

describe('a remote artifact carrying a negated output', () => {
  it(
    'is refused at ingest, so the read is a miss and nothing lands there',
    async () => {
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: { build: {
          exec: { command: 'mkdir -p out && echo built > out/a.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**', '!out/keep.txt'] } },
        } } }`,
      )
      const src = path.join(fx.root, '.entry')
      await writeFile(src, 'REMOTE')
      const remote: RemoteCacheLayer = {
        endpoint: 'mem://test',
        async has() {
          return true
        },
        async get(hash: string) {
          const outputs = new Map([
            ['outputs/out/a.txt', src],
            ['outputs/out/keep.txt', src],
          ])
          const tar = await packArtifactBytes(
            await planArtifact({ key: hash, stdout: '', outputs }),
          )
          return { body: new Blob([Bun.zstdCompressSync(tar)]), durationMs: 1 }
        },
        async put() {},
      }
      const r = await run({
        cwd: fx.root,
        tasks: ['build'],
        log: silentLogger(fx),
        remoteCache: remote,
      })
      expect({
        status: r.outcomes[0]!.status,
        out: read('out/a.txt'),
        keep: existsSync(path.join(app, 'out', 'keep.txt')),
        said: fx.log.some((l) =>
          l.includes("outputs/out/keep.txt, which is not one of the task's declared outputs"),
        ),
      }).toEqual({ status: 'success', out: 'built\n', keep: false, said: true })
    },
    TIMEOUT,
  )
})

describe('vx watch and a negated output', () => {
  it('sees an edit to the path taken back, and ignores the outputs', () => {
    const dir = path.join(fx.root, 'packages', 'app')
    const ignore = makeWatchIgnore(
      path.join(fx.root, '.vx'),
      new Map([[dir, ['dist/**', '!dist/keep.txt']]]),
    )
    expect([
      ignore(dir, 'dist/keep.txt'),
      ignore(dir, 'dist/a.js'),
      ignore(dir, 'src/a.txt'),
    ]).toEqual([false, true, false])
  })
})
