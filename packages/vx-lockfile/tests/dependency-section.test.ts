// Moving a dependency between `dependencies`, `devDependencies` and
// `optionalDependencies` changes what an install that omits dev or optional
// packages lays out (npm `omit=dev`, `pnpm install --prod`, `bun install
// --production`), and the lockfile records the move. Each parser merged the
// sections into one name → version map, so no key moved and a fresh run
// failed "Cannot find module" while the cached success replayed (probed
// with real installs of npm 10, pnpm 10 and bun 1.3).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { VxPlugin } from '@vzn/vx'
import * as plugins from '../src/index.js'
import * as bun from '../src/bun.js'
import * as npm from '../src/npm.js'
import * as pnpm from '../src/pnpm.js'
import { packageSettings } from '../src/yarn-settings.js'
import { lockedKey } from './helpers/key.js'

type Section = 'dependencies' | 'devDependencies' | 'optionalDependencies'

const npmLock = (root: Section, a: Section): string =>
  JSON.stringify({
    name: 'ws',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'ws', workspaces: ['packages/*'], [root]: { 'is-odd': '3.0.1' } },
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/is-odd': {
        version: '3.0.1',
        resolved: 'https://r/is-odd-3.0.1.tgz',
        integrity: 'sha512-odd',
        ...(root === 'devDependencies' ? { dev: true } : {}),
        ...(root === 'optionalDependencies' ? { optional: true } : {}),
      },
      'node_modules/ms': {
        version: '2.1.3',
        resolved: 'https://r/ms-2.1.3.tgz',
        integrity: 'sha512-ms',
      },
      'packages/a': { name: 'a', version: '1.0.0', [a]: { ms: '^2' } },
    },
  })

const pnpmLock = (root: Section, a: Section): string => `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    ${root}:
      is-odd:
        specifier: 3.0.1
        version: 3.0.1

  packages/a:
    ${a}:
      ms:
        specifier: ^2
        version: 2.1.3

packages:

  is-odd@3.0.1:
    resolution: {integrity: sha512-odd}

  ms@2.1.3:
    resolution: {integrity: sha512-ms}

snapshots:

  is-odd@3.0.1: {}

  ms@2.1.3: {}
`

const bunLock = (root: Section, a: Section): string => `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "ws",
      "${root}": { "is-odd": "3.0.1" },
    },
    "packages/a": {
      "name": "a",
      "${a}": { "ms": "^2" },
    },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],
    "is-odd": ["is-odd@3.0.1", "", {}, "sha512-odd"],
    "ms": ["ms@2.1.3", "", {}, "sha512-ms"],
  }
}
`

interface Manager {
  plugin: () => VxPlugin
  file: string
  text: (root: Section, a: Section) => string
  digests: (text: string) => ReadonlyMap<string, string>
}

const managers: Record<string, Manager> = {
  npm: {
    plugin: plugins.npm,
    file: 'package-lock.json',
    text: npmLock,
    digests: (t) => npm.importerDigests(npm.parseLockfile(t)),
  },
  pnpm: {
    plugin: plugins.pnpm,
    file: 'pnpm-lock.yaml',
    text: pnpmLock,
    digests: (t) => pnpm.importerDigests(pnpm.parseLockfile(t)),
  },
  bun: {
    plugin: plugins.bun,
    file: 'bun.lock',
    text: bunLock,
    digests: (t) => bun.importerDigests(bun.parseLockfile(t)),
  },
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-dependency-section-'))
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'ws', workspaces: ['packages/*'] }),
  )
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe.each(Object.entries(managers))('%s', (_name, m) => {
  it("a root dependency moved to devDependencies or optionalDependencies re-keys a workspace's task", async () => {
    const key = async (section: Section): Promise<string> => {
      await writeFile(path.join(root, m.file), m.text(section, 'dependencies'))
      const plugin = m.plugin()
      const cache = path.join(root, '.vx', 'cache')
      return JSON.stringify(await lockedKey(plugin, root, cache, path.join(root, 'packages', 'a')))
    }
    const base = await key('dependencies')
    expect(await key('devDependencies')).not.toBe(base)
    expect(await key('optionalDependencies')).not.toBe(base)
  })

  it("a workspace's dependency moved to devDependencies re-keys that workspace alone", () => {
    const base = m.digests(m.text('dependencies', 'dependencies'))
    const after = m.digests(m.text('dependencies', 'devDependencies'))
    expect(after.get('packages/a')).not.toBe(base.get('packages/a'))
    expect(after.get('.')).toBe(base.get('.'))
  })
})

// yarn.lock records no section (berry merges a workspace's devDependencies
// into `dependencies`), so yarn() keys every task on the root manifest's
// dependency fields instead; a workspace's own manifest is its tasks' input.
it('yarn: a root dependency moved to devDependencies moves the settings every task keys on', () => {
  const pkg = (field: Section) => JSON.stringify({ name: 'ws', [field]: { 'is-odd': '3.0.1' } })
  expect(packageSettings(pkg('devDependencies'))).not.toBe(packageSettings(pkg('dependencies')))
  expect(packageSettings(pkg('optionalDependencies'))).not.toBe(
    packageSettings(pkg('dependencies')),
  )
})
