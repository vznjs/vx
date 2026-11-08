// Yarn 1.22: root devDependencies is-number ^6 → ^7 while packages/a
// ^7 → ^6 leaves yarn.lock byte-identical (classic records no importer,
// only the ranges asked), yet root node_modules/is-number moves 6 → 7.
// Project c declares nothing and resolves is-number from the root, so it
// hit and replayed 6.0.0, and `--affected` selected only a.
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
const rootManifest = (devDependencies: Record<string, string>) => ({
  name: 'r',
  private: true,
  workspaces: ['packages/*'],
  devDependencies,
})
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-yarn-root-deps-'))
  await write('package.json', rootManifest({ 'is-number': '^6.0.0' }))
  await write('packages/a/package.json', { name: 'a', dependencies: { 'is-number': '^7.0.0' } })
  await write('packages/c/package.json', { name: 'c' })
  await write('yarn.lock', LOCK)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const keyOfC = async (): Promise<string> =>
  JSON.stringify(
    await lockedKey(yarn(), root, path.join(root, '.vx', 'cache'), path.join(root, 'packages/c')),
  )

it("a classic root's dependency ranges key every task", async () => {
  const before = await keyOfC()
  await write('package.json', rootManifest({ 'is-number': '^7.0.0' }))
  await write('packages/a/package.json', { name: 'a', dependencies: { 'is-number': '^6.0.0' } })
  expect(await keyOfC()).not.toBe(before)
})

it("a change to the root's dependency ranges selects every project under --affected", () => {
  const enc = new TextEncoder()
  const ctx = { workspaceRoot: root, cacheDir: root, warn() {}, projects: [] }
  const affectedBy = (before: unknown, after: unknown): unknown =>
    yarn().fingerprint!.affected(
      {
        file: 'package.json',
        before: enc.encode(JSON.stringify(before)),
        after: enc.encode(JSON.stringify(after)),
      },
      ctx,
    )
  expect(
    affectedBy(rootManifest({ 'is-number': '^6.0.0' }), rootManifest({ 'is-number': '^7.0.0' })),
  ).toBeUndefined()
  // Key order is no install change.
  expect(
    affectedBy(
      rootManifest({ 'is-number': '^6.0.0', 'is-odd': '^3.0.0' }),
      rootManifest({ 'is-odd': '^3.0.0', 'is-number': '^6.0.0' }),
    ),
  ).toEqual([])
})
