// A gitignored path is an input only when the config asks for it outright
// (2026-10-16): a literal naming it, or a glob whose fixed prefix is
// an ignored directory (`dist/**`), which is then walked on disk. Its bytes
// are hashed from disk, never stored. A broad glob (`**`, `src/**`) still
// skips what git ignores, so `node_modules` is never walked.

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, spyOn } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { GitFilesCache, namedIgnoredReach } from '../src/cache/index.js'
import { gitFiles } from '../src/cli/watch-filter.js'
import { dry, planned, PARITY_TIMEOUT as TIMEOUT, summarized, vx } from './helpers/parity.js'

let root: string
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const task = (inputs: string, extra = '') =>
  `{ exec: { command: 'true' }, ${extra} inputs: ${inputs}, outputs: { files: [] }, cache: true }`

async function workspace(
  tasks: Record<string, string>,
  files: Record<string, string> = {},
  gitignore = '',
): Promise<string> {
  const ws = await makeWorkspace({ prefix: 'vx-ignored-inputs-' })
  await addProject(ws, 'lib', {
    config: `export default { name: 'lib', tasks: { ${Object.entries(tasks)
      .map(([n, t]) => `${n}: ${t}`)
      .join(', ')} } }\n`,
    files: { 'src/a.txt': 'a\n', ...files },
  })
  await writeFile(path.join(ws, '.gitignore'), `.vx/cache/\n${gitignore}`)
  const git = gitIn(ws)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return ws
}

const pkg = (rel: string) => path.join(root, 'packages', 'lib', rel)
async function key(id = 'lib#t'): Promise<string> {
  const t = (await dry(root, [id])).find((x) => x.id === id)
  if (t === undefined) throw new Error(`${id} not planned`)
  return t.hash
}

it(
  'a literal naming a gitignored file is an input: missing, then created, then edited, each moves the key',
  async () => {
    root = await workspace({ t: task("{ files: ['src/**', '.env.local'] }") }, {}, '.env.local\n')
    const missing = await key()
    await writeFile(pkg('.env.local'), 'API=a\n')
    const a = await key()
    expect(a).not.toBe(missing)
    await writeFile(pkg('.env.local'), 'API=b\n')
    const b = await key()
    expect(b).not.toBe(a)
    await writeFile(pkg('.env.local'), 'API=a\n')
    expect(await key()).toBe(a)
  },
  TIMEOUT,
)

it(
  'a literal in workspaceFiles naming a gitignored root file is an input',
  async () => {
    root = await workspace(
      { t: task("{ files: ['src/**'], workspaceFiles: ['.env.local'] }") },
      {},
      '.env.local\n',
    )
    await writeFile(path.join(root, '.env.local'), 'API=a\n')
    const a = await key()
    await writeFile(path.join(root, '.env.local'), 'API=b\n')
    expect(await key()).not.toBe(a)
  },
  TIMEOUT,
)

it(
  'a glob whose fixed prefix is a gitignored directory walks it on disk; a broad glob still skips it',
  async () => {
    root = await workspace(
      {
        t: task("{ files: ['src/**', 'gen/**'] }"),
        broad: task("{ files: ['**'] }"),
        js: task("{ files: ['src/**', 'gen/*.js'] }"),
      },
      {},
      'packages/lib/gen/\nnode_modules/\n',
    )
    await mkdir(pkg('gen/deep'), { recursive: true })
    await writeFile(pkg('gen/deep/a.json'), '1\n')
    await writeFile(pkg('gen/b.js'), '1\n')
    await mkdir(pkg('node_modules/x'), { recursive: true })
    await writeFile(pkg('node_modules/x/i.js'), '1\n')
    const before = new Map(
      (await dry(root, ['lib#t', 'lib#broad', 'lib#js'])).map((t) => [t.id, t.hash]),
    )
    await writeFile(pkg('gen/deep/a.json'), '2\n')
    await writeFile(pkg('node_modules/x/i.js'), '2\n')
    const after = new Map(
      (await dry(root, ['lib#t', 'lib#broad', 'lib#js'])).map((t) => [t.id, t.hash]),
    )
    expect(after.get('lib#t')).not.toBe(before.get('lib#t'))
    expect(after.get('lib#broad')).toBe(before.get('lib#broad'))
    // `gen/*.js` reads only what it matches: a json under gen moves nothing.
    expect(after.get('lib#js')).toBe(before.get('lib#js'))
    await writeFile(pkg('gen/b.js'), '2\n')
    expect(await key('lib#js')).not.toBe(before.get('lib#js'))
  },
  TIMEOUT,
)

// `node_modules` is no special case (2026-10-16): an ignored path
// named outright is an input. A generated client (`prisma generate` writes
// node_modules/.prisma/client) folded nothing, silently, and a build
// replayed its output after the client changed.
it(
  'an ignored path under node_modules is an input like any other: named outright, or under a named ignored prefix',
  async () => {
    root = await workspace(
      {
        t: task("{ files: ['src/**', 'node_modules/.prisma/client/**'] }"),
        gen: task("{ files: ['src/**', 'gen/**'] }"),
      },
      {},
      'node_modules/\npackages/lib/gen/\n',
    )
    await mkdir(pkg('node_modules/.prisma/client'), { recursive: true })
    await writeFile(pkg('node_modules/.prisma/client/index.d.ts'), 'type A = 1\n')
    await mkdir(pkg('gen/node_modules/x'), { recursive: true })
    await writeFile(pkg('gen/node_modules/x/i.js'), '1\n')
    const before = new Map((await dry(root, ['lib#t', 'lib#gen'])).map((t) => [t.id, t.hash]))
    await writeFile(pkg('node_modules/.prisma/client/index.d.ts'), 'type A = 2\n')
    await writeFile(pkg('gen/node_modules/x/i.js'), '2\n')
    const after = new Map((await dry(root, ['lib#t', 'lib#gen'])).map((t) => [t.id, t.hash]))
    expect([
      after.get('lib#t') !== before.get('lib#t'),
      after.get('lib#gen') !== before.get('lib#gen'),
    ]).toEqual([true, true])
  },
  TIMEOUT,
)

it(
  'CONTROL: a gitignored file no entry names outright stays out of the key',
  async () => {
    root = await workspace({ t: task("{ files: ['src/**'] }") }, {}, 'packages/lib/src/local.env\n')
    const before = await key()
    await writeFile(pkg('src/local.env'), 'X=1\n')
    expect(await key()).toBe(before)
  },
  TIMEOUT,
)

it(
  '--affected reflects only what git sees: a gitignored input never selects a task on its own, its key still moves',
  async () => {
    root = await workspace(
      {
        t: task("{ files: ['src/**', '.env.local'] }"),
        plain: task("{ files: ['src/**'] }"),
      },
      {},
      '.env.local\n',
    )
    expect((await vx(root, ['lock'])).code).toBe(0)
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'lock')
    expect((await vx(root, ['run', 't', 'plain', '--all', '--affected=HEAD'])).err).toContain(
      'nothing affected since HEAD',
    )
    const before = await key()
    await writeFile(pkg('.env.local'), 'API=a\n')
    expect((await vx(root, ['run', 't', 'plain', '--all', '--affected=HEAD'])).err).toContain(
      'nothing affected since HEAD',
    )
    expect(await key()).not.toBe(before)
    // CONTROL: a tracked input of the same task selects it.
    await writeFile(pkg('src/a.txt'), 'a2\n')
    expect((await planned(root, ['t', 'plain', '--all', '--affected=HEAD'])).sort()).toEqual([
      'lib#plain',
      'lib#t',
    ])
  },
  TIMEOUT,
)

it(
  'an input glob into a gitignored output of another task is refused by vx lock',
  async () => {
    root = await workspace(
      {
        build: `{ exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true }`,
        t: task("{ files: ['src/**', 'dist/**'] }"),
      },
      {},
      'dist/\n',
    )
    const r = await vx(root, ['lock'])
    expect(r.code).not.toBe(0)
    expect(r.out + r.err).toContain(
      'lib#t reads "dist/**" in inputs.files, which matches lib#build\'s output',
    )
  },
  TIMEOUT,
)

const producer = `{ exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true }`

it(
  'a task may read a dependency’s ignored outputs its key does not fold: it hashes the bytes',
  async () => {
    root = await workspace(
      {
        build: producer,
        t: `{ exec: { command: 'cat dist/out.txt' }, dependsOn: ['build'], inputs: { files: ['dist/**'], tasks: [] }, outputs: { files: [] }, cache: true }`,
      },
      { 'src/b.txt': 'b\n' },
      'dist/\n',
    )
    const status = async () => {
      const r = await summarized(root, ['lib#t'])
      expect(r.code).toBe(0)
      const hit = (id: string) => (r.tasks.get(id)?.['status'] === 'cache-hit' ? 'hit' : 'miss')
      return [hit('lib#build'), hit('lib#t')]
    }
    expect(await status()).toEqual(['miss', 'miss'])
    expect(await status()).toEqual(['hit', 'hit'])
    // The producer re-runs and writes the same bytes: the reader still hits.
    await writeFile(pkg('src/b.txt'), 'b2\n')
    expect(await status()).toEqual(['miss', 'hit'])
    await writeFile(pkg('src/a.txt'), 'a2\n')
    expect(await status()).toEqual(['miss', 'miss'])
  },
  TIMEOUT,
)

it(
  'vx lock refuses a read of outputs the reader’s key folds, directly or through another task',
  async () => {
    const reader = (deps: string, tasks: string) =>
      `{ exec: { command: 'true' }, dependsOn: [${deps}], inputs: { files: ['dist/**']${tasks} }, outputs: { files: [] }, cache: true }`
    const lock = async (tasks: Record<string, string>) => {
      root = await workspace({ build: producer, ...tasks }, {}, 'dist/\n')
      const r = await vx(root, ['lock'])
      await rm(root, { recursive: true, force: true })
      return r.code === 0 ? null : r.out + r.err
    }
    const refusal = "leave it out of lib#t's inputs.tasks, so its key hashes those bytes instead"
    // A direct dependant is told it depends, and only the fix left to it.
    const direct =
      "leave lib#build out of lib#t's inputs.tasks, so its key hashes those bytes instead"
    expect(await lock({ t: reader("'build'", '') })).toContain(direct)
    expect(await lock({ t: reader("'build'", ", tasks: ['build']") })).toContain(direct)
    // `mid` folds `build`, and `t` folds `mid`: `build`'s key reaches `t`'s.
    const mid = `{ exec: { command: 'true' }, dependsOn: ['build'], inputs: { files: [] }, outputs: { files: [] }, cache: true }`
    expect(await lock({ mid, t: reader("'mid'", ", tasks: ['mid']") })).toContain(refusal)
    // CONTROL: `mid` folds nothing, so `build` reaches `t` only as an order.
    const midBare = mid.replace('files: [] }', 'files: [], tasks: [] }')
    expect(await lock({ mid: midBare, t: reader("'mid'", ", tasks: ['mid']") })).toBeNull()
    expect(await lock({ t: reader("'build'", ', tasks: []') })).toBeNull()
  },
  TIMEOUT,
)

it(
  'a brace of whole paths names each gitignored path outright, as its expansions would',
  async () => {
    root = await workspace(
      {
        t: task("{ files: ['{gen/a.txt,gen/b.txt}'] }"),
        u: task("{ files: ['{gen,out}/**'] }"),
      },
      { 'gen/a.txt': '1\n', 'out/x.txt': 'x\n' },
      'gen/\nout/\n',
    )
    const t = await key('lib#t')
    const u = await key('lib#u')
    await writeFile(pkg('gen/a.txt'), '2\n')
    expect(await key('lib#t')).not.toBe(t)
    const u2 = await key('lib#u')
    expect(u2).not.toBe(u)
    await writeFile(pkg('out/x.txt'), 'y\n')
    expect(await key('lib#u')).not.toBe(u2)
  },
  TIMEOUT,
)

it(
  'a prefix whose new files git ignores is walked on disk though a file under it is tracked',
  async () => {
    // `gen/*` + `!gen/.gitkeep` keeps the directory in git; `gen/` with a
    // force-added file does the same. Either way git lists a file under
    // `gen`, so the prefix read as listed and the untracked files beside it
    // never entered the key: an edit to one replayed the old output.
    root = await workspace(
      { t: task("{ files: ['gen/**'] }"), u: task("{ files: ['out/**'] }") },
      { 'gen/.gitkeep': '', 'gen/client.ts': 'v1\n', 'out/a.txt': 'a\n', 'out/b.txt': 'b1\n' },
      '**/gen/*\n!**/gen/.gitkeep\nout/\n',
    )
    gitIn(root)('add', '-f', 'packages/lib/out/a.txt')
    gitIn(root)('commit', '-q', '-m', 'force-add')
    const t = await key('lib#t')
    const u = await key('lib#u')
    await writeFile(pkg('gen/client.ts'), 'v2\n')
    await writeFile(pkg('out/b.txt'), 'b2\n')
    expect(await key('lib#t')).not.toBe(t)
    expect(await key('lib#u')).not.toBe(u)
  },
  TIMEOUT,
)

it(
  'CONTROL: a broad glob over a listed directory still skips a file a pattern ignores',
  async () => {
    root = await workspace(
      { t: task("{ files: ['src/**'] }") },
      { 'src/x.generated.js': 'v1\n' },
      '*.generated.js\n',
    )
    const t = await key('lib#t')
    await writeFile(pkg('src/x.generated.js'), 'v2\n')
    expect(await key('lib#t')).toBe(t)
  },
  TIMEOUT,
)

it(
  'a walked ignored prefix skips the cache directory under it: the task hits',
  async () => {
    // `tmp/` is ignored and named outright, so `tmp/**` walks it on disk,
    // and `--cache-dir tmp/vx-cache` put the cache under it. The walk read
    // the index every run wrote, and the task never hit.
    root = await workspace(
      {
        t: task("{ files: ['src/**'], workspaceFiles: ['tmp/**'] }"),
        u: task("{ files: ['src/**', 'tmp/**'] }"),
      },
      {},
      'tmp/\npackages/lib/tmp/\n',
    )
    await mkdir(path.join(root, 'tmp'), { recursive: true })
    await writeFile(path.join(root, 'tmp', 'note.txt'), 'n1\n')
    await mkdir(pkg('tmp'), { recursive: true })
    await writeFile(pkg('tmp/note.txt'), 'n1\n')
    const status = async (cacheDir: string) => {
      const r = await summarized(root, ['lib#t', 'lib#u', '--cache-dir', cacheDir])
      expect(r.code).toBe(0)
      const hit = (id: string) => (r.tasks.get(id)?.['status'] === 'cache-hit' ? 'hit' : 'miss')
      return [hit('lib#t'), hit('lib#u')]
    }
    for (const dir of ['tmp/vx-cache', 'packages/lib/tmp/vx-cache']) {
      expect(await status(dir)).toEqual(['miss', 'miss'])
      expect(await status(dir)).toEqual(['hit', 'hit'])
    }
    // CONTROL: the rest of the walked prefix is still an input.
    await writeFile(path.join(root, 'tmp', 'note.txt'), 'n2\n')
    await writeFile(pkg('tmp/note.txt'), 'n2\n')
    expect(await status('tmp/vx-cache')).toEqual(['miss', 'miss'])
  },
  TIMEOUT,
)

it(
  'watch reaches ignored files under the entries a key does, and no others',
  async () => {
    // Watch counted every glob's prefix: `src` of `src/**` over a listed
    // `src`, so a dev server's ignored `src/dev.log` looped it, though no
    // key reads that file.
    root = await workspace(
      { t: task("{ files: ['src/**', 'gen/**', 'dist/**', '.env.local'] }") },
      { 'gen/.gitkeep': '', 'src/dev.log': '1\n', '.env.local': 'A=1\n' },
      '**/gen/*\n!**/gen/.gitkeep\ndist/\n*.log\n.env.local\n',
    )
    const named = ['src', 'gen', 'dist', '.env.local'].map(pkg)
    expect(namedIgnoredReach(root, named, gitFiles(root)!.listed)).toEqual(
      ['gen', 'dist', '.env.local'].map(pkg),
    )
  },
  TIMEOUT,
)

// Asked once per project a run keys: `path.relative` per ask was ~2 ms of
// 1,601 projects (2026-11-07). A normalized path under the root is its rest.
it('asks no path.relative for a normalized directory under the root', () => {
  const cache = new GitFilesCache()
  cache.setIgnored('/w', ['packages/a/dist/', 'packages/b/dist/'])
  const relative = spyOn(path, 'relative')
  try {
    for (let i = 0; i < 50; i++) expect(cache.newFilesIgnored(`/w/packages/p${i}/src`)).toBe(false)
    expect(relative).toHaveBeenCalledTimes(0)
    // CONTROL: a spelling that is not plainly below the root is still
    // resolved, and answers as before.
    for (const dir of ['/w', '/w/', '/w/x/../packages/c', '/w//packages/c', '/v/packages/c'])
      expect(cache.newFilesIgnored(dir)).toBe(false)
    expect(relative).toHaveBeenCalledTimes(5)
  } finally {
    relative.mockRestore()
  }
})

// The directories a task names outright are asked in the run's one
// `check-ignore` beside the enumeration, with the outputs it gates: asked
// on the key path, it was a synchronous spawn (vueuse, 2026-11-10).
it('a directory answered beside the enumeration is asked of git no more', () => {
  const cache = new GitFilesCache()
  cache.setIgnored('/w', ['packages/a/gen/x.ts', 'packages/c/src/y.log'])
  cache.answerNewFilesIgnored(['packages/a/gen', 'packages/c/src'], (d) => d === 'packages/a/gen')
  const spawn = spyOn(Bun, 'spawnSync')
  try {
    expect(cache.newFilesIgnored('/w/packages/a/gen')).toBe(true)
    expect(cache.newFilesIgnored('/w/packages/c/src')).toBe(false)
    expect(spawn).toHaveBeenCalledTimes(0)
    // CONTROL: one it holds no answer for is still asked.
    cache.newFilesIgnored('/w/packages/c')
    expect(spawn).toHaveBeenCalled()
  } finally {
    spawn.mockRestore()
  }
})

const gating = (inputs: string) =>
  `{ exec: { command: 'true' }, inputs: ${inputs}, outputs: { files: ['dist/**'] }, cache: true }`

it(
  'a prefix git ignores new files in is walked when its answer came with the gated outputs',
  async () => {
    // `**/*` reaches the task's own `dist/**`, so the run asks git about
    // `dist` beside the enumeration, and `gen` with it.
    root = await workspace(
      { t: gating("{ files: ['**/*', 'gen/**'] }") },
      { 'gen/.gitkeep': '', 'gen/client.ts': 'v1\n' },
      '**/gen/*\n!**/gen/.gitkeep\ndist/\n',
    )
    const t = await key('lib#t')
    await writeFile(pkg('gen/client.ts'), 'v2\n')
    expect(await key('lib#t')).not.toBe(t)
  },
  TIMEOUT,
)

it(
  'a named entry past a symlink, which git refuses to check, still keys the ignored files',
  async () => {
    // git fails a whole `check-ignore` over a path beyond a symlink: the
    // gated outputs are asked again alone, and `gen` as before.
    root = await workspace(
      { t: gating("{ files: ['**/*', 'gen/**', 'link/x/**'] }") },
      { 'gen/.gitkeep': '', 'gen/client.ts': 'v1\n', 'real/x/a.txt': 'a\n' },
      '**/gen/*\n!**/gen/.gitkeep\ndist/\n',
    )
    await symlink('real', pkg('link'))
    const t = await key('lib#t')
    await writeFile(pkg('gen/client.ts'), 'v2\n')
    expect(await key('lib#t')).not.toBe(t)
  },
  TIMEOUT,
)
