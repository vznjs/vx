// A pull that adds a Yarn patch (`yarn patch-commit -s`), run with no
// install: the workspace's dependency becomes a `patch:` entry at the same
// version, the lockfile keeps the plain entry it patches, and the state
// lists the plain copy where Yarn installs the patched one. Neither a
// version nor an extra locator told them apart: the task built unpatched
// under the patched key and replayed it after the install (probed, Yarn
// 4.19, nodeLinker node-modules). The files are that install's.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { yarn } from '../src/index.js'
import { lockedKey } from './helpers/key.js'

let root: string
let cacheDir: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-yarn-patch-'))
  cacheDir = path.join(root, '.vx', 'cache')
  await mkdir(cacheDir, { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function write(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
}

const run = async (): Promise<string> => {
  try {
    await lockedKey(yarn(), root, cacheDir, path.join(root, 'packages', 'a'))
    return 'ok'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const PATCH = 'patch:is-number@npm%3A7.0.0#~/.yarn/patches/is-number-npm-7.0.0-060086935c.patch'
const PATCHED = `is-number@${PATCH}::version=7.0.0&hash=4b3620`
const PLAIN_ENTRY = `"is-number@npm:7.0.0":
  version: 7.0.0
  resolution: "is-number@npm:7.0.0"
  checksum: 10c0/b4686d
  languageName: node
  linkType: hard
`
const lock = (range: string, patched: boolean): string => `__metadata:
  version: 10
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    is-number: "${range}"
  languageName: unknown
  linkType: soft

${PLAIN_ENTRY}${
  patched
    ? `
"is-number@${PATCH}":
  version: 7.0.0
  resolution: "${PATCHED}"
  checksum: 10c0/bd3ccd
  languageName: node
  linkType: hard
`
    : ''
}
"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`
const state = (locator: string): string => `__metadata:
  version: 1
  nmMode: classic

"a@workspace:packages/a":
  locations:
    - "node_modules/a"

"${locator}":
  locations:
    - "node_modules/is-number"

"root@workspace:.":
  locations:
    - ""
`

it('refuses the plain copy installed where the lockfile names its patched entry', async () => {
  await write({
    'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
    'packages/a/package.json': `{ "name": "a", "dependencies": { "is-number": "${PATCH}" } }`,
    'yarn.lock': lock(PATCH, true),
    'node_modules/.yarn-state.yml': state('is-number@npm:7.0.0'),
    'node_modules/is-number/package.json': '{ "name": "is-number", "version": "7.0.0" }',
  })
  expect(await run()).toBe(
    `node_modules was installed from a different yarn.lock (packages/a's is-number is is-number@npm:7.0.0, the lockfile names ${PATCHED}) — run \`yarn install\``,
  )
  // CONTROL: the install the lockfile names.
  await write({ 'node_modules/.yarn-state.yml': state(PATCHED) })
  expect(await run()).toBe('ok')
})

// CONTROL: no patch, the plain copy is the install.
it('takes the plain copy where the lockfile names no patch', async () => {
  await write({
    'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
    'packages/a/package.json': '{ "name": "a", "dependencies": { "is-number": "npm:7.0.0" } }',
    'yarn.lock': lock('npm:7.0.0', false),
    'node_modules/.yarn-state.yml': state('is-number@npm:7.0.0'),
    'node_modules/is-number/package.json': '{ "name": "is-number", "version": "7.0.0" }',
  })
  expect(await run()).toBe('ok')
})
