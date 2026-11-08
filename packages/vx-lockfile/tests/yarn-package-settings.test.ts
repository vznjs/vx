// Yarn 1 lays node_modules out from the root package.json's
// `workspaces.nohoist`, and yarn.lock records none of it: `**/is-number`
// there moved is-number into packages/b/node_modules under a
// byte-identical yarn.lock (probed, yarn 1.22), and no key but the root's
// own moved. `installConfig` is the same kind of field, and so are the
// root's dependency ranges (yarn-classic-root-deps.test.ts). The rest of
// the manifest is the root's own input.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { yarn } from '../src/index.js'
import { lockedKey } from './helpers/key.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-yarn-pkg-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const key = async (): Promise<string> => {
  return JSON.stringify(await lockedKey(yarn(), root, path.join(root, '.vx', 'cache')))
}
const manifest = (pkg: Record<string, unknown>): Promise<void> =>
  writeFile(path.join(root, 'package.json'), JSON.stringify(pkg))

it("the root package.json's nohoist and installConfig key every task, and nothing else in it does", async () => {
  await manifest({ name: 'root', private: true, workspaces: ['packages/*'] })
  const base = await key()
  await manifest({
    name: 'root',
    workspaces: { packages: ['packages/*'] },
    scripts: { build: 'x' },
  })
  expect(await key()).toBe(base)
  await manifest({ name: 'root', workspaces: { packages: ['packages/*'], nohoist: ['**/x'] } })
  const nohoist = await key()
  expect(nohoist).not.toBe(base)
  await manifest({ name: 'root', workspaces: ['packages/*'], installConfig: { pnp: true } })
  expect(await key()).not.toBe(base)
  expect(await key()).not.toBe(nohoist)
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
  expect(await affectedBy({ name: 'r' }, { name: 'r', scripts: { build: 'x' } })).toEqual([])
  expect(
    await affectedBy({ name: 'r' }, { name: 'r', workspaces: { packages: [], nohoist: ['x'] } }),
  ).toBeUndefined()
})
