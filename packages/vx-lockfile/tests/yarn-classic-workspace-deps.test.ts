// Yarn 1.22: packages/a is-number ^6 → ^7 beside b's ^7 leaves yarn.lock
// byte-identical (classic records no importer, only the ranges asked),
// yet a, and c that links a, now resolve 7.0.0. Only the root manifest
// was folded, so c hit and replayed 6.0.0 and `--affected` selected
// nothing.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { yarn } from '../src/index.js'
import { lockedKey } from './helpers/key.js'

const LOCK = `# yarn lockfile v1


is-number@^6.0.0:
  version "6.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"
  integrity sha512-n6

is-number@^7.0.0:
  version "7.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-7.0.0.tgz#7535345b896734d5f80c4d06c50955527a14f12b"
  integrity sha512-n7
`

let root: string
const write = async (rel: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value))
}
const a = (range: string, extra: Record<string, unknown> = {}) => ({
  name: 'a',
  version: '1.0.0',
  dependencies: { 'is-number': range },
  ...extra,
})
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-yarn-workspace-deps-'))
  await write('package.json', { name: 'r', private: true, workspaces: ['packages/*'] })
  await write('packages/a/package.json', a('^6.0.0'))
  await write('packages/b/package.json', { name: 'b', dependencies: { 'is-number': '^7.0.0' } })
  await write('packages/c/package.json', { name: 'c', dependencies: { a: '1.0.0' } })
  await write('yarn.lock', LOCK)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const keyOfC = async (): Promise<string> =>
  JSON.stringify(
    await lockedKey(yarn(), root, path.join(root, '.vx', 'cache'), path.join(root, 'packages/c')),
  )

it("a classic workspace's dependency ranges key the tasks that reach it", async () => {
  const before = await keyOfC()
  await write('packages/a/package.json', a('^7.0.0'))
  const after = await keyOfC()
  expect(after).not.toBe(before)
  // Put back, the key is the first one again.
  await write('packages/a/package.json', a('^6.0.0'))
  expect(await keyOfC()).toBe(before)
})

it("a change to a classic workspace's ranges selects its dependents under --affected", () => {
  const enc = new TextEncoder()
  const lock = enc.encode(LOCK)
  const ctx = {
    workspaceRoot: root,
    cacheDir: root,
    warn() {},
    projects: [{ name: 'c', dir: path.join(root, 'packages/c') }],
  }
  const picked = yarn().fingerprint!.affected(
    {
      file: 'yarn.lock',
      before: lock,
      after: lock,
      extras: new Map([
        [
          'packages/a/package.json',
          {
            before: enc.encode(JSON.stringify(a('^6.0.0'))),
            after: enc.encode(JSON.stringify(a('^7.0.0'))),
          },
        ],
      ]),
    },
    ctx as never,
  )
  expect(picked).toEqual(['c'])
})
