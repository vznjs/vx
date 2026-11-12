// A `git pull` that brings a lockfile change, run with no install: the key
// folds the new lockfile, the task builds against the old node_modules,
// and the output saved under the new key replays after the install. Each
// manager's run refuses until the install. The files are what real
// installs wrote (bun 1.4.4, pnpm 10.9, npm 10, yarn 1.22), cut to `a`
// depending on is-number.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { bun, npm, pnpm, yarn } from '../src/index.js'
import { lockedKey } from './helpers/key.js'

let root: string
let cacheDir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-installed-'))
  cacheDir = path.join(root, '.vx', 'cache')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await mkdir(cacheDir, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
}

/** The run's refusal for `a`'s task, or `ok`. */
async function run(plugin: ReturnType<typeof bun>): Promise<string> {
  try {
    await lockedKey(plugin, root, cacheDir, path.join(root, 'packages', 'a'))
    return 'ok'
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const MANIFESTS = {
  'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
  'packages/a/package.json':
    '{ "name": "a", "version": "1.0.0", "dependencies": { "is-number": "7.0.0" } }',
}

const bunLock = (v: string): string => `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "root" },
    "packages/a": { "name": "a", "dependencies": { "is-number": "${v}" } },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "is-number": ["is-number@${v}", "", {}, "sha512-${v}"],
  }
}
`
const pkg = (v: string): string => `{ "name": "is-number", "version": "${v}" }`

describe('bun(): no install record, so the workspaces’ dependencies as Node resolves them', () => {
  it('refuses a workspace whose dependency is another version than the lockfile names', async () => {
    await write({
      ...MANIFESTS,
      'bun.lock': bunLock('5.0.0'),
      'node_modules/.bun/is-number@7.0.0/node_modules/is-number/package.json': pkg('7.0.0'),
      'packages/a/node_modules/is-number/package.json': pkg('7.0.0'),
    })
    expect(await run(bun())).toBe(
      "node_modules was installed from a different bun.lock (packages/a's is-number is 7.0.0, the lockfile names 5.0.0) — run `bun install`",
    )
    // CONTROL: the install the lockfile names.
    await write({ 'packages/a/node_modules/is-number/package.json': pkg('5.0.0') })
    expect(await run(bun())).toBe('ok')
  })

  // Hoisted: a workspace with no copy of its own loads the root's.
  it('reads the copy up the tree when the workspace has none', async () => {
    await write({
      ...MANIFESTS,
      'bun.lock': bunLock('5.0.0'),
      'node_modules/is-number/package.json': pkg('7.0.0'),
    })
    expect(await run(bun())).toContain("packages/a's is-number is 7.0.0")
  })

  // The match is kept and a warm run only stats; an install that replaces
  // the package moves its directory, so the next run compares again.
  it('compares again once the install moved a workspace’s node_modules', async () => {
    await write({
      ...MANIFESTS,
      'bun.lock': bunLock('5.0.0'),
      'packages/a/node_modules/is-number/package.json': pkg('5.0.0'),
    })
    const past = new Date(Date.now() - 60_000)
    await mkdir(path.join(root, 'node_modules'))
    for (const rel of ['bun.lock', 'node_modules', 'packages/a/node_modules']) {
      await utimes(path.join(root, rel), past, past)
    }
    expect(await run(bun())).toBe('ok')
    expect(
      readdirSync(cacheDir).filter((f) => f.startsWith('vx-lockfile-installed-')),
    ).toHaveLength(1)
    await rm(path.join(root, 'packages/a/node_modules/is-number'), { recursive: true })
    await write({ 'packages/a/node_modules/is-number/package.json': pkg('7.0.0') })
    expect(await run(bun())).toContain("packages/a's is-number is 7.0.0")
  })

  // A fresh clone: nothing installed can be wrong, and a task that needs
  // a package fails, which saves nothing.
  it('checks nothing where nothing is installed', async () => {
    await write({ ...MANIFESTS, 'bun.lock': bunLock('5.0.0') })
    expect(await run(bun())).toBe('ok')
    expect(readdirSync(cacheDir)).toEqual([])
  })
})

const npmLock = (v: string): string => `{
  "name": "root",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "root", "workspaces": ["packages/*"] },
    "node_modules/a": { "resolved": "packages/a", "link": true },
    "node_modules/is-number": { "version": "${v}", "resolved": "https://registry.npmjs.org/is-number/-/is-number-${v}.tgz", "integrity": "sha512-${v}" },
    "packages/a": { "version": "1.0.0", "dependencies": { "is-number": "${v}" } }
  }
}
`
// npm's hidden lockfile: the lockfile's entries as installed, no root.
const npmTree = (v: string): string => {
  const lock = JSON.parse(npmLock(v))
  delete lock.packages['']
  return JSON.stringify(lock)
}

describe('npm(): node_modules/.package-lock.json', () => {
  it('refuses a package installed at another version than the lockfile names', async () => {
    await write({
      ...MANIFESTS,
      'package-lock.json': npmLock('5.0.0'),
      'node_modules/.package-lock.json': npmTree('7.0.0'),
    })
    expect(await run(npm())).toBe(
      'node_modules was installed from a different package-lock.json (node_modules/is-number is 7.0.0, the lockfile names 5.0.0) — run `npm install`',
    )
    await write({ 'node_modules/.package-lock.json': npmTree('5.0.0') })
    expect(await run(npm())).toBe('ok')
  })

  // Read as no record, a cut-off write would have let the old tree pass.
  it('refuses a record it cannot read, naming it', async () => {
    await write({
      ...MANIFESTS,
      'package-lock.json': npmLock('5.0.0'),
      'node_modules/.package-lock.json': '{',
    })
    expect(await run(npm())).toStartWith('node_modules/.package-lock.json: cannot be read (')
  })

  // `npm ci --omit=dev` leaves dev packages out of the tree and its record.
  it('takes a dev package the install left out', async () => {
    const lock = JSON.parse(npmLock('5.0.0'))
    lock.packages['node_modules/is-even'] = { version: '1.0.0', dev: true }
    await write({
      ...MANIFESTS,
      'package-lock.json': JSON.stringify(lock),
      'node_modules/.package-lock.json': npmTree('5.0.0'),
    })
    expect(await run(npm())).toBe('ok')
  })
})

const pnpmLock = (v: string): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/a:
    dependencies:
      is-number:
        specifier: ${v}
        version: ${v}

packages:

  is-number@${v}:
    resolution: {integrity: sha512-${v}}

snapshots:

  is-number@${v}: {}
`

describe('pnpm(): node_modules/.pnpm/lock.yaml', () => {
  it('refuses an importer linking another version than the lockfile names', async () => {
    await write({
      ...MANIFESTS,
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'pnpm-lock.yaml': pnpmLock('5.0.0'),
      'node_modules/.pnpm/lock.yaml': pnpmLock('7.0.0'),
    })
    expect(await run(pnpm())).toBe(
      "node_modules was installed from a different pnpm-lock.yaml (packages/a's is-number is 7.0.0, the lockfile names 5.0.0) — run `pnpm install`",
    )
    await write({ 'node_modules/.pnpm/lock.yaml': pnpmLock('5.0.0') })
    expect(await run(pnpm())).toBe('ok')
  })
})

const yarnClassic = (
  v: string,
): string => `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


is-number@${v}:
  version "${v}"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-${v}.tgz#${v}"
  integrity sha512-${v}
`
const integrity = (v: string): string =>
  JSON.stringify({
    systemParams: 'linux-x64-127',
    topLevelPatterns: ['a@1.0.0', `is-number@${v}`],
    lockfileEntries: {
      [`is-number@${v}`]: `https://registry.yarnpkg.com/is-number/-/is-number-${v}.tgz#${v}`,
    },
  })

const yarnBerry = (
  v: string,
): string => `# This file is generated by running "yarn install" inside your project.

__metadata:
  version: 8
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    is-number: "npm:${v}"
  languageName: unknown
  linkType: soft

"is-number@npm:${v}":
  version: ${v}
  resolution: "is-number@npm:${v}"
  checksum: 10c0/${v}
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`
const yarnState = (
  v: string,
): string => `# Warning: This file is automatically generated. Removing it is fine, but will
# cause your node_modules installation to become invalidated.

__metadata:
  version: 1
  nmMode: classic

"a@workspace:packages/a":
  locations:
    - "node_modules/a"

"is-number@npm:${v}":
  locations:
    - "node_modules/is-number"

"root@workspace:.":
  locations:
    - ""
`

describe('yarn(): node_modules/.yarn-integrity (1) and .yarn-state.yml (2+)', () => {
  it('refuses an entry Yarn 1 installed that the lockfile does not list', async () => {
    await write({
      ...MANIFESTS,
      'yarn.lock': yarnClassic('5.0.0'),
      'node_modules/.yarn-integrity': integrity('7.0.0'),
    })
    expect(await run(yarn())).toBe(
      'node_modules was installed from a different yarn.lock (is-number@7.0.0 is installed, and the lockfile does not list it) — run `yarn install`',
    )
    await write({ 'node_modules/.yarn-integrity': integrity('5.0.0') })
    expect(await run(yarn())).toBe('ok')
  })

  it('refuses a package Yarn 2+ installed that the lockfile does not resolve to', async () => {
    await write({
      ...MANIFESTS,
      'yarn.lock': yarnBerry('5.0.0'),
      'node_modules/.yarn-state.yml': yarnState('7.0.0'),
    })
    expect(await run(yarn())).toBe(
      'node_modules was installed from a different yarn.lock (is-number@npm:7.0.0 is installed, and the lockfile does not list it) — run `yarn install`',
    )
    await write({ 'node_modules/.yarn-state.yml': yarnState('5.0.0') })
    expect(await run(yarn())).toBe('ok')
  })
})
