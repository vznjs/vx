// Yarn 1.22 with `"c": "link:../c"` in packages/b, c a workspace: the file
// keys `"c@link:packages/c"` and node_modules/c is the workspace's own
// link. Its content was folded like a linked directory that is no
// workspace, into the one classic digest every task folds: any edit under
// c, its own build output included, re-keyed every task in the repo.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { DiscoverContext, TaskNode } from '@vzn/vx'
import { yarn } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-yarn-link-ws-'))
  const write = async (rel: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  await write(
    'package.json',
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
  )
  await write('packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { b: '*' } }))
  await write(
    'packages/b/package.json',
    JSON.stringify({
      name: 'b',
      dependencies: { c: 'link:../c', d: 'file:../d', l: 'link:../../vendor/l' },
    }),
  )
  await write('packages/c/package.json', JSON.stringify({ name: 'c', version: '1.0.0' }))
  await write('packages/c/dist/index.js', '// v1\n')
  await write('packages/d/package.json', JSON.stringify({ name: 'd', version: '1.0.0' }))
  await write('packages/d/index.js', '// v1\n')
  await write('vendor/l/package.json', JSON.stringify({ name: 'l', version: '1.0.0' }))
  await write('vendor/l/index.js', '// v1\n')
  await write(
    'yarn.lock',
    '# yarn lockfile v1\n\n\n"c@link:packages/c":\n  version "1.0.0"\n\n"d@file:packages/d":\n  version "1.0.0"\n\n"l@link:vendor/l":\n  version "1.0.0"\n',
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One run's key for a task in packages/a: a fresh plugin and context, as a new process has. */
async function key(): Promise<string> {
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn() {} }
  const task = { projectDir: path.join(root, 'packages/a') } as TaskNode
  return JSON.stringify(await yarn().key!(task, ctx))
}

it('an edit under a workspace a classic `link:` names moves no key', async () => {
  const before = await key()
  await writeFile(path.join(root, 'packages/c/dist/index.js'), '// v2\n')
  expect(await key()).toBe(before)
})

it('CONTROL: an edit under a linked directory that is no workspace moves the key', async () => {
  const before = await key()
  await writeFile(path.join(root, 'vendor/l/index.js'), '// v2\n')
  expect(await key()).not.toBe(before)
})

it('CONTROL: an edit under a workspace a classic `file:` copies moves the key', async () => {
  const before = await key()
  await writeFile(path.join(root, 'packages/d/index.js'), '// v2\n')
  expect(await key()).not.toBe(before)
})

it('a workspace a `!` glob names is still one: Yarn 1 links it anyway', async () => {
  // Yarn 1.22 takes no `!` glob (`yarn workspaces info` lists the
  // directory), as the importers read it; the link test honoured the `!`,
  // and c's own build output re-keyed every task, c's included.
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*', '!packages/c'] }),
  )
  const before = await key()
  await writeFile(path.join(root, 'packages/c/dist/index.js'), '// v2\n')
  expect(await key()).toBe(before)
})

it('a `link:` to a workspace under another name is an edge to it', async () => {
  // Yarn 1 symlinks the directory whatever the name; the edge came only
  // from the name, so `"y": "link:../c"` ordered nothing and b's ^build
  // ran beside c's.
  await writeFile(
    path.join(root, 'packages/b/package.json'),
    JSON.stringify({ name: 'b', dependencies: { y: 'link:../c', d: 'file:../d' } }),
  )
  await writeFile(
    path.join(root, 'yarn.lock'),
    '# yarn lockfile v1\n\n\n"d@file:packages/d":\n  version "1.0.0"\n\n"y@link:packages/c":\n  version "1.0.0"\n',
  )
  const ctx: DiscoverContext = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    projects: [],
    warn() {},
    worktreeChanges: async () => null,
  }
  const rel = (dir: string) => path.relative(root, dir)
  const b = (await yarn().discover!(ctx)).find((p) => rel(p.dir) === 'packages/b')!
  // CONTROL: the `file:` copy of d is no edge.
  expect((b.deps ?? []).map(rel)).toEqual(['packages/c'])
})

// `--affected` now asks about paths inside projects too, so the files it
// is told the lockfile names must be the ones the key hashes: with the
// linked workspace among them, an edit under c selected every project.
it("--affected's extra files leave out a workspace a classic `link:` names, as the key does", async () => {
  const ctx = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    warn() {},
    projects: [],
  }
  const bytes = await Bun.file(path.join(root, 'yarn.lock')).bytes()
  const named = await yarn().fingerprint!.extraFiles!('yarn.lock', bytes, ctx)
  expect([...named].sort()).toEqual(['packages/d', 'vendor/l'])
})
