// Yarn 4 keeps catalogs in `.yarnrc.yml`, and yarn.lock records each
// workspace's `catalog:` literally beside the entry the range resolved to.
// Folded whole into every task, one catalog bump re-keyed every project,
// those that never name the package included (probed, Yarn 4.19). The
// digest reads the catalog to reach the entry it names, so the file folds
// without it; `--affected` still selects every project on a catalog edit:
// the base side's digest reads the working tree's `.yarnrc.yml`.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { yarn } from '../src/index.js'
import { lockedKey } from './helpers/key.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-yarn-catalog-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const key = async (): Promise<string> =>
  JSON.stringify(await lockedKey(yarn(), root, path.join(root, '.vx', 'cache')))
const write = (text: string): Promise<void> => writeFile(path.join(root, '.yarnrc.yml'), text)
const affected = (before: string, after: string): unknown => {
  const enc = new TextEncoder()
  const change = { file: '.yarnrc.yml', before: enc.encode(before), after: enc.encode(after) }
  const ctx = { workspaceRoot: root, cacheDir: root, warn() {}, projects: [] }
  return yarn().fingerprint!.affected(change, ctx)
}

const BASE = 'nodeLinker: node-modules\n'
const CATALOGS = (range: string) =>
  `${BASE}catalog:\n  is-number: ${range}\ncatalogs:\n  odd:\n    is-odd: ^3.0.1\n`

it('a catalog in .yarnrc.yml keys no task by itself', async () => {
  await write(BASE)
  const base = await key()
  await write(CATALOGS('^7.0.0'))
  expect(await key()).toBe(base)
})

it('a catalog edit selects every project under --affected', () => {
  expect(affected(CATALOGS('^6.0.0'), CATALOGS('^7.0.0'))).toBeUndefined()
})

it('any other .yarnrc.yml setting keys every task, and a file that does not parse folds whole', async () => {
  await write(CATALOGS('^7.0.0'))
  const base = await key()
  await write(`nodeLinker: pnpm\n${CATALOGS('^7.0.0').slice(BASE.length)}`)
  const linker = await key()
  expect(linker).not.toBe(base)
  await write('catalog: [')
  expect(await key()).not.toBe(linker)
})
