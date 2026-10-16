// A gitignored path is an input only when the config asks for it outright
// (owner, 2026-10-16): a literal naming it, or a glob whose fixed prefix is
// an ignored directory (`dist/**`), which is then walked on disk. Its bytes
// are hashed from disk, never stored. A broad glob (`**`, `src/**`) still
// skips what git ignores, so `node_modules` is never walked.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry, planned, PARITY_TIMEOUT as TIMEOUT, summarized, vx } from './helpers/parity.js'

let root: string
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const task = (inputs: string, extra = '') =>
  `{ exec: { command: 'true' }, ${extra} inputs: ${inputs}, cache: { outputs: { files: [] } } }`

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
  '--affected selects a task that names a gitignored input: git cannot say it is unchanged',
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
    await writeFile(pkg('.env.local'), 'API=a\n')
    expect(await planned(root, ['t', 'plain', '--all', '--affected=HEAD'])).toEqual(['lib#t'])
  },
  TIMEOUT,
)

it(
  'an input glob into a gitignored output of another task is refused by vx lock',
  async () => {
    root = await workspace(
      {
        build: `{ exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } }`,
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

const producer = `{ exec: { command: 'mkdir -p dist && cat src/a.txt > dist/out.txt' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } } }`

it(
  'a task may read a dependency’s ignored outputs its key does not fold: it hashes the bytes',
  async () => {
    root = await workspace(
      {
        build: producer,
        t: `{ exec: { command: 'cat dist/out.txt' }, dependsOn: ['build'], inputs: { files: ['dist/**'], tasks: [] }, cache: { outputs: { files: [] } } }`,
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
      `{ exec: { command: 'true' }, dependsOn: [${deps}], inputs: { files: ['dist/**']${tasks} }, cache: { outputs: { files: [] } } }`
    const lock = async (tasks: Record<string, string>) => {
      root = await workspace({ build: producer, ...tasks }, {}, 'dist/\n')
      const r = await vx(root, ['lock'])
      await rm(root, { recursive: true, force: true })
      return r.code === 0 ? null : r.out + r.err
    }
    const refusal = "leave it out of lib#t's inputs.tasks, so its key hashes those bytes instead"
    expect(await lock({ t: reader("'build'", '') })).toContain(refusal)
    expect(await lock({ t: reader("'build'", ", tasks: ['build']") })).toContain(refusal)
    // `mid` folds `build`, and `t` folds `mid`: `build`'s key reaches `t`'s.
    const mid = `{ exec: { command: 'true' }, dependsOn: ['build'], inputs: { files: [] }, cache: { outputs: { files: [] } } }`
    expect(await lock({ mid, t: reader("'mid'", ", tasks: ['mid']") })).toContain(refusal)
    // CONTROL: `mid` folds nothing, so `build` reaches `t` only as an order.
    const midBare = mid.replace('files: [] }', 'files: [], tasks: [] }')
    expect(await lock({ mid: midBare, t: reader("'mid'", ", tasks: ['mid']") })).toBeNull()
    expect(await lock({ t: reader("'build'", ', tasks: []') })).toBeNull()
  },
  TIMEOUT,
)
