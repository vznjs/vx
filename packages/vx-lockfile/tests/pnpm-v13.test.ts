// pnpm's v13 lockfile (`lockfile.format: v13`, pnpm 12.20+): one JSON-like
// document, `projects` for `importers`, one `packages` entry per
// `name@version` and no peer suffix. Read as v9, it had no importers: no
// project folded a dependency and a bump replayed every old output. Each
// fixture below is what pnpm 12.21 wrote for one workspace in both
// formats, so the v13 read must be the v9 read.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { stalenessFacts } from '../src/pnpm-blocks.js'
import { importerDigests, parseLockfile, recordedImporters } from '../src/pnpm.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

const FIELDS = [
  'importers',
  'sections',
  'snapshots',
  'resolutions',
  'patches',
  'directories',
  'published',
  'excludesLinks',
] as const

const PAIRS = (): [string, string, string][] => [
  [
    'catalog, alias, file: directory, peer variants',
    CATALOG_ALIAS_FILE_PEERS_V13,
    CATALOG_ALIAS_FILE_PEERS_V9,
  ],
  ['fixed and varying optional peers', FIXED_AND_VARYING_PEERS_V13, FIXED_AND_VARYING_PEERS_V9],
  [
    'override, tarball, link:, injected',
    OVERRIDE_TARBALL_LINK_INJECTED_V13,
    OVERRIDE_TARBALL_LINK_INJECTED_V9,
  ],
  [
    'peer from below, patch, named catalog',
    BELOW_PEER_PATCH_NAMED_CATALOG_V13,
    BELOW_PEER_PATCH_NAMED_CATALOG_V9,
  ],
  // pnpm/pnpm's own `which: npm:@pnpm/which@^3.0.1`: read as `3.0.1`, the
  // entry named no package and the lock refused the workspace.
  ['catalog entry that is an npm: alias', CATALOG_NPM_ALIAS_V13, CATALOG_NPM_ALIAS_V9],
]

describe('pnpm v13 lockfile', () => {
  for (const [what, v13, v9] of PAIRS()) {
    it(`reads as its v9 twin: ${what}`, () => {
      const a = parseLockfile(v13)
      const b = parseLockfile(v9)
      expect(a.version).toBe('13.0')
      expect(a.importers.size).toBeGreaterThan(1)
      for (const field of FIELDS) expect([field, a[field]]).toEqual([field, b[field]])
      // The install-wide material differs by the version alone: `settings`
      // keeps what v9 holds at the top level, and that is read per importer.
      expect(a.global).toBe(b.global.replaceAll('"9.0"', '"13.0"'))
      expect(importerDigests(a)).toEqual(importerDigests({ ...b, global: a.global }))
    })

    it(`the staleness check reads its projects as the whole parse does: ${what}`, () => {
      const names = (m: ReadonlyMap<string, ReadonlyMap<string, string>>) =>
        [...m].map(([dir, deps]) => [dir, [...deps.keys()].sort()])
      expect(names(recordedImporters(v13))).toEqual(names(parseLockfile(v13).importers))
    })
  }

  it('a bump moves the projects that reach it under that peer variant and no other', () => {
    const before = importerDigests(parseLockfile(CATALOG_ALIAS_FILE_PEERS_V13))
    // react@19.0.0 is b's alone: a and ui reach use-sync-external-store under react 18.
    const after = importerDigests(
      parseLockfile(
        CATALOG_ALIAS_FILE_PEERS_V13.replace(
          'sha512-V8AVnmPIICiWpGfm6GLzCR',
          'sha512-XXXXnmPIICiWpGfm6GLzCR',
        ),
      ),
    )
    expect(after.get('apps/b')).not.toBe(before.get('apps/b'))
    expect(after.get('apps/a')).toBe(before.get('apps/a'))
    expect(after.get('packages/ui')).toBe(before.get('packages/ui'))
  })

  it('a catalog bump moves the project that names `catalog:` and no other', () => {
    const before = importerDigests(parseLockfile(CATALOG_ALIAS_FILE_PEERS_V13))
    const after = importerDigests(
      parseLockfile(
        CATALOG_ALIAS_FILE_PEERS_V13.replace(
          /("specifier": "\^3\.0\.1",\s*"version": )"3\.0\.1"/,
          '$1"0.1.2"',
        ),
      ),
    )
    expect(after.get('apps/a')).not.toBe(before.get('apps/a'))
    expect(after.get('apps/b')).toBe(before.get('apps/b'))
  })

  it('reads its last document behind an env lockfile, which moves every project', () => {
    const env = (v: string) =>
      `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    configDependencies:\n      is-even:\n        specifier: ${v}\n        version: ${v}\n\n---\n`
    const plain = parseLockfile(OVERRIDE_TARBALL_LINK_INJECTED_V13)
    const withEnv = parseLockfile(`${env('1.0.0')}${OVERRIDE_TARBALL_LINK_INJECTED_V13}`)
    expect(withEnv.importers).toEqual(plain.importers)
    expect(withEnv.snapshots).toEqual(plain.snapshots)
    const a = importerDigests(withEnv)
    const b = importerDigests(parseLockfile(`${env('1.0.1')}${OVERRIDE_TARBALL_LINK_INJECTED_V13}`))
    for (const dir of plain.importers.keys()) expect(a.get(dir)).not.toBe(b.get(dir))
    expect(recordedImporters(`${env('1.0.0')}${OVERRIDE_TARBALL_LINK_INJECTED_V13}`)).toEqual(
      recordedImporters(OVERRIDE_TARBALL_LINK_INJECTED_V13),
    )
  })

  it('a package peering on its own dependant resolves to it', () => {
    const v13 = `{
	"lockfileVersion": "13.0",
	"projects": {
		"a": {"dependencies": {"eslint": "9.14.0"}},
	},
	"packages": {
		"eslint@9.14.0": {"integrity": "sha512-e", "dependencies": {"utils": "4.10.1"}},
		"utils@4.10.1": {"integrity": "sha512-u", "peerDependencies": {"eslint": "^9"}},
	},
}
`
    const lock = parseLockfile(v13)
    expect(lock.importers.get('a')).toEqual(new Map([['eslint', '9.14.0']]))
    expect([...lock.snapshots].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual([
      ['eslint@9.14.0', new Map([['utils', '4.10.1(eslint@9.14.0)']])],
      ['utils@4.10.1(eslint@9.14.0)', new Map([['eslint', '9.14.0']])],
    ])
  })

  it('the staleness check reads `settings` where v13 keeps it', () => {
    const v13 = `{
	"lockfileVersion": "13.0",
	"settings": {
		"excludeLinksFromLockfile": true,
		"ignoredOptionalDependencies": [
			"is-buffer",
		],
	},
	"projects": {},
	"packages": {},
}
`
    expect(stalenessFacts(v13)).toEqual(['links', 'optional:1:is-buffer'])
    expect(parseLockfile(v13).excludesLinks).toBe(true)
  })
})

describe('vx run with pnpm() over a v13 lockfile', () => {
  let root: string
  const BUILD =
    "export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true } } }\n"
  const silent = (): Logger =>
    ({
      runStart() {},
      taskStart() {},
      taskStdout() {},
      taskStderr() {},
      taskComplete() {},
      runStatus() {},
      runEnd() {},
      status() {},
    }) as never

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-v13-'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true }),
    )
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - 'apps/*'\n  - 'packages/*'\nlockfile:\n  format: v13\n",
    )
    const manifests: Record<string, object> = {
      'apps/a': { name: 'a', dependencies: { '@w/ui': 'workspace:*' } },
      'apps/b': { name: 'b', dependencies: { '@w/ui': 'workspace:^' } },
      'packages/ui': { name: '@w/ui' },
    }
    for (const [dir, pkg] of Object.entries(manifests)) {
      await mkdir(path.join(root, dir, 'src'), { recursive: true })
      await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(pkg))
      await writeFile(path.join(root, dir, 'src', 'index.js'), `// ${dir}\n`)
      await writeFile(path.join(root, dir, 'vx.config.mjs'), BUILD)
    }
    await mkdir(path.join(root, 'vendor', 'loc'), { recursive: true })
    await writeFile(path.join(root, 'vendor', 'loc', 'package.json'), '{"name":"loc"}')
    await writeFile(path.join(root, 'pnpm-lock.yaml'), CATALOG_ALIAS_FILE_PEERS_V13)
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource(['pnpm()'], `import { pnpm } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const hashes = async (): Promise<Record<string, string>> => {
    const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
    return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
  }

  it('a dependency bump re-keys only the projects that reach it', async () => {
    const before = await hashes()
    await writeFile(
      path.join(root, 'pnpm-lock.yaml'),
      CATALOG_ALIAS_FILE_PEERS_V13.replace(
        'sha512-V8AVnmPIICiWpGfm6GLzCR',
        'sha512-XXXXnmPIICiWpGfm6GLzCR',
      ),
    )
    const after = await hashes()
    expect(after['b#build']).not.toBe(before['b#build'])
    expect(after['a#build']).toBe(before['a#build'])
    expect(after['@w/ui#build']).toBe(before['@w/ui#build'])
  })
})

const CATALOG_ALIAS_FILE_PEERS_V13 = `{
	"lockfileVersion": "13.0",

	"settings": {
		"autoInstallPeers": true,
		"excludeLinksFromLockfile": false,
		"catalogs": {
			"default": {
				"is-odd": {
					"specifier": "^3.0.1",
					"version": "3.0.1",
				},
			},
		},
	},

	"projects": {
		".": {},

		"apps/a": {
			"dependencies": {
				"@w/ui": "workspace:*",
				"al": "npm:is-even@1.0.0",
				"is-odd": "catalog:",
				"loc": {
					"specifier": "file:../../vendor/loc",
					"version": "file:vendor/loc",
				},
				"react": "18.3.1",
				"react-dom": "18.3.1",
			},
		},

		"apps/b": {
			"dependencies": {
				"@w/ui": "workspace:^",
				"react": "19.0.0",
				"react-dom": "19.0.0",
				"use-sync-external-store": "1.2.0",
			},
		},

		"packages/ui": {
			"name": "@w/ui",
			"dependencies": {
				"use-sync-external-store": "1.2.0",
			},
			"devDependencies": {
				"react": "18.3.1",
			},
		},
	},

	"packages": {
		"is-buffer@1.1.6": {
			"integrity": "sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==",
		},

		"is-even@1.0.0": {
			"integrity": "sha512-LEhnkAdJqic4Dbqn58A0y52IXoHWlsueqQkKfMfdEnIYG8A1sm/GHidKkS6yvXlMoRrkM34csHnXQtOqcb+Jzg==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-odd": "0.1.2",
			},
		},

		"is-number@3.0.0": {
			"integrity": "sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"kind-of": "3.2.2",
			},
		},

		"is-number@6.0.0": {
			"integrity": "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==",
			"engines": {"node": ">=0.10.0"},
		},

		"is-odd@0.1.2": {
			"integrity": "sha512-Ri7C2K7o5IrUU9UEI8losXJCCD/UtsaIrkR5sxIcFg4xQ9cRJXlWA5DQvTE0yDc0krvSNLsRGXN11UPS6KyfBw==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-number": "3.0.0",
			},
		},

		"is-odd@3.0.1": {
			"integrity": "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==",
			"engines": {"node": ">=4"},
			"dependencies": {
				"is-number": "6.0.0",
			},
		},

		"js-tokens@4.0.0": {
			"integrity": "sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==",
		},

		"kind-of@3.2.2": {
			"integrity": "sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-buffer": "1.1.6",
			},
		},

		"loc@file:vendor/loc": {
			"specifiers": {
				"dependencies": {
					"is-number": "^6.0.0",
				},
				"manifestSource": "path",
			},
			"dependencies": {
				"is-number": "6.0.0",
			},
		},

		"loose-envify@1.4.0": {
			"integrity": "sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==",
			"hasBin": true,
			"dependencies": {
				"js-tokens": "4.0.0",
			},
		},

		"react-dom@18.3.1": {
			"integrity": "sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==",
			"peerDependencies": {
				"react": {
					"specifier": "^18.3.1",
					"version": "18.3.1",
				},
			},
			"dependencies": {
				"loose-envify": "1.4.0",
				"scheduler": "0.23.2",
			},
		},

		"react-dom@19.0.0": {
			"integrity": "sha512-4GV5sHFG0e/0AD4X+ySy6UJd3jVl1iNsNHdpad0qhABJ11twS3TTBnseqsKurKcsNqCEFeGL3uLpVChpIO3QfQ==",
			"peerDependencies": {
				"react": {
					"specifier": "^19.0.0",
					"version": "19.0.0",
				},
			},
			"dependencies": {
				"scheduler": "0.25.0",
			},
		},

		"react@18.3.1": {
			"integrity": "sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"loose-envify": "1.4.0",
			},
		},

		"react@19.0.0": {
			"integrity": "sha512-V8AVnmPIICiWpGfm6GLzCR/W5FXLchHop40W4nXBmdlEceh16rCN8O8LNWm5bh5XUX91fh7KpA+W0TgMKmgTpQ==",
			"engines": {"node": ">=0.10.0"},
		},

		"scheduler@0.23.2": {
			"integrity": "sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==",
			"dependencies": {
				"loose-envify": "1.4.0",
			},
		},

		"scheduler@0.25.0": {
			"integrity": "sha512-xFVuu11jh+xcO7JOAGJNOXld8/TcEHK/4CituBUeUb5hqxJLj9YuemAEuvm9gQ/+pgXYfbQuqAkiYu+u7YEsNA==",
		},

		"use-sync-external-store@1.2.0": {
			"integrity": "sha512-eEgnFxGQ1Ife9bzYs6VLi8/4X6CObHMw9Qr9tPY43iKwsPw8xE8+EFsf/2cFZ5S3esXgpWgtSCtLNS41F+sKPA==",
			"peerDependencies": {
				"react": "^16.8.0 || ^17.0.0 || ^18.0.0",
			},
			"snapshots": [
				{
					"peerDependencies": {
						"react": {
							"version": "18.3.1",
						},
					},
				},
				{
					"peerDependencies": {
						"react": {
							"version": "19.0.0",
						},
					},
				},
			],
		},
	},
}
`

const CATALOG_ALIAS_FILE_PEERS_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

catalogs:
  default:
    is-odd:
      specifier: ^3.0.1
      version: 3.0.1

importers:

  .: {}

  apps/a:
    dependencies:
      '@w/ui':
        specifier: workspace:*
        version: link:../../packages/ui
      al:
        specifier: npm:is-even@1.0.0
        version: is-even@1.0.0
      is-odd:
        specifier: 'catalog:'
        version: 3.0.1
      loc:
        specifier: file:../../vendor/loc
        version: file:vendor/loc
      react:
        specifier: 18.3.1
        version: 18.3.1
      react-dom:
        specifier: 18.3.1
        version: 18.3.1(react@18.3.1)

  apps/b:
    dependencies:
      '@w/ui':
        specifier: workspace:^
        version: link:../../packages/ui
      react:
        specifier: 19.0.0
        version: 19.0.0
      react-dom:
        specifier: 19.0.0
        version: 19.0.0(react@19.0.0)
      use-sync-external-store:
        specifier: 1.2.0
        version: 1.2.0(react@19.0.0)

  packages/ui:
    dependencies:
      use-sync-external-store:
        specifier: 1.2.0
        version: 1.2.0(react@18.3.1)
    devDependencies:
      react:
        specifier: 18.3.1
        version: 18.3.1

packages:

  is-buffer@1.1.6:
    resolution: {integrity: sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==}

  is-even@1.0.0:
    resolution: {integrity: sha512-LEhnkAdJqic4Dbqn58A0y52IXoHWlsueqQkKfMfdEnIYG8A1sm/GHidKkS6yvXlMoRrkM34csHnXQtOqcb+Jzg==}
    engines: {node: '>=0.10.0'}

  is-number@3.0.0:
    resolution: {integrity: sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg==}
    engines: {node: '>=0.10.0'}

  is-number@6.0.0:
    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}
    engines: {node: '>=0.10.0'}

  is-odd@0.1.2:
    resolution: {integrity: sha512-Ri7C2K7o5IrUU9UEI8losXJCCD/UtsaIrkR5sxIcFg4xQ9cRJXlWA5DQvTE0yDc0krvSNLsRGXN11UPS6KyfBw==}
    engines: {node: '>=0.10.0'}

  is-odd@3.0.1:
    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}
    engines: {node: '>=4'}

  js-tokens@4.0.0:
    resolution: {integrity: sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}

  kind-of@3.2.2:
    resolution: {integrity: sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==}
    engines: {node: '>=0.10.0'}

  loc@file:vendor/loc:
    resolution: {directory: vendor/loc, type: directory}

  loose-envify@1.4.0:
    resolution: {integrity: sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==}
    hasBin: true

  react-dom@18.3.1:
    resolution: {integrity: sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==}
    peerDependencies:
      react: ^18.3.1

  react-dom@19.0.0:
    resolution: {integrity: sha512-4GV5sHFG0e/0AD4X+ySy6UJd3jVl1iNsNHdpad0qhABJ11twS3TTBnseqsKurKcsNqCEFeGL3uLpVChpIO3QfQ==}
    peerDependencies:
      react: ^19.0.0

  react@18.3.1:
    resolution: {integrity: sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==}
    engines: {node: '>=0.10.0'}

  react@19.0.0:
    resolution: {integrity: sha512-V8AVnmPIICiWpGfm6GLzCR/W5FXLchHop40W4nXBmdlEceh16rCN8O8LNWm5bh5XUX91fh7KpA+W0TgMKmgTpQ==}
    engines: {node: '>=0.10.0'}

  scheduler@0.23.2:
    resolution: {integrity: sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==}

  scheduler@0.25.0:
    resolution: {integrity: sha512-xFVuu11jh+xcO7JOAGJNOXld8/TcEHK/4CituBUeUb5hqxJLj9YuemAEuvm9gQ/+pgXYfbQuqAkiYu+u7YEsNA==}

  use-sync-external-store@1.2.0:
    resolution: {integrity: sha512-eEgnFxGQ1Ife9bzYs6VLi8/4X6CObHMw9Qr9tPY43iKwsPw8xE8+EFsf/2cFZ5S3esXgpWgtSCtLNS41F+sKPA==}
    peerDependencies:
      react: ^16.8.0 || ^17.0.0 || ^18.0.0

snapshots:

  is-buffer@1.1.6: {}

  is-even@1.0.0:
    dependencies:
      is-odd: 0.1.2

  is-number@3.0.0:
    dependencies:
      kind-of: 3.2.2

  is-number@6.0.0: {}

  is-odd@0.1.2:
    dependencies:
      is-number: 3.0.0

  is-odd@3.0.1:
    dependencies:
      is-number: 6.0.0

  js-tokens@4.0.0: {}

  kind-of@3.2.2:
    dependencies:
      is-buffer: 1.1.6

  loc@file:vendor/loc:
    dependencies:
      is-number: 6.0.0

  loose-envify@1.4.0:
    dependencies:
      js-tokens: 4.0.0

  react-dom@18.3.1(react@18.3.1):
    dependencies:
      loose-envify: 1.4.0
      react: 18.3.1
      scheduler: 0.23.2

  react-dom@19.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0
      scheduler: 0.25.0

  react@18.3.1:
    dependencies:
      loose-envify: 1.4.0

  react@19.0.0: {}

  scheduler@0.23.2:
    dependencies:
      loose-envify: 1.4.0

  scheduler@0.25.0: {}

  use-sync-external-store@1.2.0(react@18.3.1):
    dependencies:
      react: 18.3.1

  use-sync-external-store@1.2.0(react@19.0.0):
    dependencies:
      react: 19.0.0
`

const FIXED_AND_VARYING_PEERS_V13 = `{
	"lockfileVersion": "13.0",

	"settings": {
		"autoInstallPeers": true,
		"excludeLinksFromLockfile": false,
	},

	"projects": {
		".": {},

		"apps/a": {
			"dependencies": {
				"react": "18.2.0",
				"react-redux": "8.1.3",
			},
		},

		"apps/b": {
			"dependencies": {
				"react": "18.3.1",
				"react-redux": "8.1.3",
				"redux": "4.2.1",
			},
			"devDependencies": {
				"@types/react": "18.2.0",
			},
		},
	},

	"packages": {
		"@babel/runtime@7.29.14": {
			"integrity": "sha512-Y5tqevQaUAZhhj82BpYMNC1ssvLQTVAfwKdm8iy8qwmhvC2/CpcAu8OC+QEtjM7pMk7knx83u1Qj8gzkicyelw==",
			"engines": {"node": ">=6.9.0"},
		},

		"@types/hoist-non-react-statics@3.3.7": {
			"integrity": "sha512-PQTyIulDkIDro8P+IHbKCsw7U2xxBYflVzW/FgWdCAePD9xGSidgA76/GeJ6lBKoblyhf9pBY763gbrN+1dI8g==",
			"peerDependencies": {
				"@types/react": {
					"specifier": "*",
					"version": "18.2.0",
				},
			},
			"dependencies": {
				"hoist-non-react-statics": "3.3.2",
			},
		},

		"@types/prop-types@15.7.15": {
			"integrity": "sha512-F6bEyamV9jKGAFBEmlQnesRPGOQqS2+Uwi0Em15xenOxHaf2hv6L8YCVn3rPdPJOiJfPiCnLIRyvwVaqMY3MIw==",
		},

		"@types/react@18.2.0": {
			"integrity": "sha512-0FLj93y5USLHdnhIhABk83rm8XEGA7kH3cr+YUlvxoUGp1xNt/DINUMvqPxLyOQMzLmZe8i4RTHbvb8MC7NmrA==",
			"dependencies": {
				"@types/prop-types": "15.7.15",
				"@types/scheduler": "0.28.0",
				"csstype": "3.2.4",
			},
		},

		"@types/scheduler@0.28.0": {
			"integrity": "sha512-WuK7EQ0YBvNbYwanHo+x3kixrg10+7Ak4rmYmy1dYo3l4FCh0XWeoq/SdqQamKA5wShXse8WRhh0Tt1czTAuTQ==",
		},

		"@types/use-sync-external-store@0.0.3": {
			"integrity": "sha512-EwmlvuaxPNej9+T4v5AuBPJa2x2UOJVdjCtDHgcDqitUeOtjnJKJ+apYjVcAoBEMjKW1VVFGZLUb5+qqa09XFA==",
		},

		"csstype@3.2.4": {
			"integrity": "sha512-PoKaoPzQapnEoqUSnHx1u6W6ku8CVEgKsnpmmzU3m1nwkidpPBQ8V/Zq2+bWNrsOKoKLwTGdbx6xF7BXP1zLVQ==",
		},

		"hoist-non-react-statics@3.3.2": {
			"integrity": "sha512-/gGivxi8JPKWNm/W0jSmzcMPpfpPLc3dY/6GxhX2hQ9iGj3aDfklV4ET7NjKpSinLpJ5vafa9iiGIEZg10SfBw==",
			"dependencies": {
				"react-is": "16.13.1",
			},
		},

		"js-tokens@4.0.0": {
			"integrity": "sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==",
		},

		"loose-envify@1.4.0": {
			"integrity": "sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==",
			"hasBin": true,
			"dependencies": {
				"js-tokens": "4.0.0",
			},
		},

		"react-is@16.13.1": {
			"integrity": "sha512-24e6ynE2H+OKt4kqsOvNd8kBpV65zoxbA4BVsEOB3ARVWQki/DHzaUoC5KuON/BiccDaCCTZBuOcfZs70kR8bQ==",
		},

		"react-is@18.3.1": {
			"integrity": "sha512-/LLMVyas0ljjAtoYiPqYiL8VWXzUUdThrmU5+n20DZv+a+ClRoevUzw5JxU+Ieh5/c87ytoTBV9G1FiKfNJdmg==",
		},

		"react-redux@8.1.3": {
			"integrity": "sha512-n0ZrutD7DaX/j9VscF+uTALI3oUPa/pO4Z3soOBIjuRn/FzVu6aehhysxZCLi6y7duMf52WNZGMl7CtuK5EnRw==",
			"peerDependencies": {
				"@types/react": {
					"specifier": "^16.8 || ^17.0 || ^18.0",
					"version": "18.2.0",
					"optional": true,
				},
				"@types/react-dom": {
					"specifier": "^16.8 || ^17.0 || ^18.0",
					"optional": true,
				},
				"react": "^16.8 || ^17.0 || ^18.0",
				"react-dom": {
					"specifier": "^16.8 || ^17.0 || ^18.0",
					"optional": true,
				},
				"react-native": {
					"specifier": ">=0.59",
					"optional": true,
				},
				"redux": {
					"specifier": "^4 || ^5.0.0-beta.0",
					"version": "4.2.1",
					"optional": true,
				},
			},
			"dependencies": {
				"@babel/runtime": "7.29.14",
				"@types/hoist-non-react-statics": "3.3.7",
				"@types/use-sync-external-store": "0.0.3",
				"hoist-non-react-statics": "3.3.2",
				"react-is": "18.3.1",
				"use-sync-external-store": "1.7.0",
			},
			"snapshots": [
				{
					"peerDependencies": {
						"react": {
							"version": "18.2.0",
						},
					},
				},
				{
					"peerDependencies": {
						"react": {
							"version": "18.3.1",
						},
					},
				},
			],
		},

		"react@18.2.0": {
			"integrity": "sha512-/3IjMdb2L9QbBdWiW5e3P2/npwMBaU9mHCSCUzNln0ZCYbcfTsGbTJrU/kGemdH2IWmB2ioZ+zkxtmq6g09fGQ==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"loose-envify": "1.4.0",
			},
		},

		"react@18.3.1": {
			"integrity": "sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"loose-envify": "1.4.0",
			},
		},

		"redux@4.2.1": {
			"integrity": "sha512-LAUYz4lc+Do8/g7aeRa8JkyDErK6ekstQaqWQrNRW//MY1TvCEpMtpTWvlQ+FPbWCx+Xixu/6SHt5N0HR+SB4w==",
			"dependencies": {
				"@babel/runtime": "7.29.14",
			},
		},

		"use-sync-external-store@1.7.0": {
			"integrity": "sha512-6L+EeigHMQhdaIPNIFUKwfWJSwWFQ8gJbJ2DLOs5sDIegTwR9fRxvnM3uciHKjIZhFz+KAv2emhWMRvDmMcY8A==",
			"peerDependencies": {
				"react": "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0",
			},
			"snapshots": [
				{
					"peerDependencies": {
						"react": {
							"version": "18.2.0",
						},
					},
				},
				{
					"peerDependencies": {
						"react": {
							"version": "18.3.1",
						},
					},
				},
			],
		},
	},
}
`

const FIXED_AND_VARYING_PEERS_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  apps/a:
    dependencies:
      react:
        specifier: 18.2.0
        version: 18.2.0
      react-redux:
        specifier: 8.1.3
        version: 8.1.3(@types/react@18.2.0)(react@18.2.0)(redux@4.2.1)

  apps/b:
    dependencies:
      react:
        specifier: 18.3.1
        version: 18.3.1
      react-redux:
        specifier: 8.1.3
        version: 8.1.3(@types/react@18.2.0)(react@18.3.1)(redux@4.2.1)
      redux:
        specifier: 4.2.1
        version: 4.2.1
    devDependencies:
      '@types/react':
        specifier: 18.2.0
        version: 18.2.0

packages:

  '@babel/runtime@7.29.14':
    resolution: {integrity: sha512-Y5tqevQaUAZhhj82BpYMNC1ssvLQTVAfwKdm8iy8qwmhvC2/CpcAu8OC+QEtjM7pMk7knx83u1Qj8gzkicyelw==}
    engines: {node: '>=6.9.0'}

  '@types/hoist-non-react-statics@3.3.7':
    resolution: {integrity: sha512-PQTyIulDkIDro8P+IHbKCsw7U2xxBYflVzW/FgWdCAePD9xGSidgA76/GeJ6lBKoblyhf9pBY763gbrN+1dI8g==}
    peerDependencies:
      '@types/react': '*'

  '@types/prop-types@15.7.15':
    resolution: {integrity: sha512-F6bEyamV9jKGAFBEmlQnesRPGOQqS2+Uwi0Em15xenOxHaf2hv6L8YCVn3rPdPJOiJfPiCnLIRyvwVaqMY3MIw==}

  '@types/react@18.2.0':
    resolution: {integrity: sha512-0FLj93y5USLHdnhIhABk83rm8XEGA7kH3cr+YUlvxoUGp1xNt/DINUMvqPxLyOQMzLmZe8i4RTHbvb8MC7NmrA==}

  '@types/scheduler@0.28.0':
    resolution: {integrity: sha512-WuK7EQ0YBvNbYwanHo+x3kixrg10+7Ak4rmYmy1dYo3l4FCh0XWeoq/SdqQamKA5wShXse8WRhh0Tt1czTAuTQ==}

  '@types/use-sync-external-store@0.0.3':
    resolution: {integrity: sha512-EwmlvuaxPNej9+T4v5AuBPJa2x2UOJVdjCtDHgcDqitUeOtjnJKJ+apYjVcAoBEMjKW1VVFGZLUb5+qqa09XFA==}

  csstype@3.2.4:
    resolution: {integrity: sha512-PoKaoPzQapnEoqUSnHx1u6W6ku8CVEgKsnpmmzU3m1nwkidpPBQ8V/Zq2+bWNrsOKoKLwTGdbx6xF7BXP1zLVQ==}

  hoist-non-react-statics@3.3.2:
    resolution: {integrity: sha512-/gGivxi8JPKWNm/W0jSmzcMPpfpPLc3dY/6GxhX2hQ9iGj3aDfklV4ET7NjKpSinLpJ5vafa9iiGIEZg10SfBw==}

  js-tokens@4.0.0:
    resolution: {integrity: sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}

  loose-envify@1.4.0:
    resolution: {integrity: sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==}
    hasBin: true

  react-is@16.13.1:
    resolution: {integrity: sha512-24e6ynE2H+OKt4kqsOvNd8kBpV65zoxbA4BVsEOB3ARVWQki/DHzaUoC5KuON/BiccDaCCTZBuOcfZs70kR8bQ==}

  react-is@18.3.1:
    resolution: {integrity: sha512-/LLMVyas0ljjAtoYiPqYiL8VWXzUUdThrmU5+n20DZv+a+ClRoevUzw5JxU+Ieh5/c87ytoTBV9G1FiKfNJdmg==}

  react-redux@8.1.3:
    resolution: {integrity: sha512-n0ZrutD7DaX/j9VscF+uTALI3oUPa/pO4Z3soOBIjuRn/FzVu6aehhysxZCLi6y7duMf52WNZGMl7CtuK5EnRw==}
    peerDependencies:
      '@types/react': ^16.8 || ^17.0 || ^18.0
      '@types/react-dom': ^16.8 || ^17.0 || ^18.0
      react: ^16.8 || ^17.0 || ^18.0
      react-dom: ^16.8 || ^17.0 || ^18.0
      react-native: '>=0.59'
      redux: ^4 || ^5.0.0-beta.0
    peerDependenciesMeta:
      '@types/react':
        optional: true
      '@types/react-dom':
        optional: true
      react-dom:
        optional: true
      react-native:
        optional: true
      redux:
        optional: true

  react@18.2.0:
    resolution: {integrity: sha512-/3IjMdb2L9QbBdWiW5e3P2/npwMBaU9mHCSCUzNln0ZCYbcfTsGbTJrU/kGemdH2IWmB2ioZ+zkxtmq6g09fGQ==}
    engines: {node: '>=0.10.0'}

  react@18.3.1:
    resolution: {integrity: sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==}
    engines: {node: '>=0.10.0'}

  redux@4.2.1:
    resolution: {integrity: sha512-LAUYz4lc+Do8/g7aeRa8JkyDErK6ekstQaqWQrNRW//MY1TvCEpMtpTWvlQ+FPbWCx+Xixu/6SHt5N0HR+SB4w==}

  use-sync-external-store@1.7.0:
    resolution: {integrity: sha512-6L+EeigHMQhdaIPNIFUKwfWJSwWFQ8gJbJ2DLOs5sDIegTwR9fRxvnM3uciHKjIZhFz+KAv2emhWMRvDmMcY8A==}
    peerDependencies:
      react: ^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0

snapshots:

  '@babel/runtime@7.29.14': {}

  '@types/hoist-non-react-statics@3.3.7(@types/react@18.2.0)':
    dependencies:
      '@types/react': 18.2.0
      hoist-non-react-statics: 3.3.2

  '@types/prop-types@15.7.15': {}

  '@types/react@18.2.0':
    dependencies:
      '@types/prop-types': 15.7.15
      '@types/scheduler': 0.28.0
      csstype: 3.2.4

  '@types/scheduler@0.28.0': {}

  '@types/use-sync-external-store@0.0.3': {}

  csstype@3.2.4: {}

  hoist-non-react-statics@3.3.2:
    dependencies:
      react-is: 16.13.1

  js-tokens@4.0.0: {}

  loose-envify@1.4.0:
    dependencies:
      js-tokens: 4.0.0

  react-is@16.13.1: {}

  react-is@18.3.1: {}

  react-redux@8.1.3(@types/react@18.2.0)(react@18.2.0)(redux@4.2.1):
    dependencies:
      '@babel/runtime': 7.29.14
      '@types/hoist-non-react-statics': 3.3.7(@types/react@18.2.0)
      '@types/use-sync-external-store': 0.0.3
      hoist-non-react-statics: 3.3.2
      react: 18.2.0
      react-is: 18.3.1
      use-sync-external-store: 1.7.0(react@18.2.0)
    optionalDependencies:
      '@types/react': 18.2.0
      redux: 4.2.1

  react-redux@8.1.3(@types/react@18.2.0)(react@18.3.1)(redux@4.2.1):
    dependencies:
      '@babel/runtime': 7.29.14
      '@types/hoist-non-react-statics': 3.3.7(@types/react@18.2.0)
      '@types/use-sync-external-store': 0.0.3
      hoist-non-react-statics: 3.3.2
      react: 18.3.1
      react-is: 18.3.1
      use-sync-external-store: 1.7.0(react@18.3.1)
    optionalDependencies:
      '@types/react': 18.2.0
      redux: 4.2.1

  react@18.2.0:
    dependencies:
      loose-envify: 1.4.0

  react@18.3.1:
    dependencies:
      loose-envify: 1.4.0

  redux@4.2.1:
    dependencies:
      '@babel/runtime': 7.29.14

  use-sync-external-store@1.7.0(react@18.2.0):
    dependencies:
      react: 18.2.0

  use-sync-external-store@1.7.0(react@18.3.1):
    dependencies:
      react: 18.3.1
`

const OVERRIDE_TARBALL_LINK_INJECTED_V13 = `{
	"lockfileVersion": "13.0",

	"settings": {
		"autoInstallPeers": true,
		"excludeLinksFromLockfile": false,
		"overrides": {
			"is-number@3": "3.0.0",
		},
	},

	"projects": {
		".": {},

		"apps/a": {
			"dependencies": {
				"is-even": "1.0.0",
				"lib": "workspace:*",
				"outside": "link:../../outside",
				"tg": {
					"specifier": "file:../../vendor/tg.tgz",
					"version": "file:vendor/tg.tgz",
				},
			},
			"dependenciesMeta": {
				"lib": {
					"injected": true,
				},
			},
			"devDependencies": {
				"kind-of": "3.2.2",
			},
			"optionalDependencies": {
				"is-buffer": "1.1.6",
			},
		},

		"packages/lib": {
			"name": "lib",
			"dependencies": {
				"is-odd": "0.1.2",
			},
		},
	},

	"packages": {
		"is-buffer@1.1.6": {
			"integrity": "sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==",
		},

		"is-even@1.0.0": {
			"integrity": "sha512-LEhnkAdJqic4Dbqn58A0y52IXoHWlsueqQkKfMfdEnIYG8A1sm/GHidKkS6yvXlMoRrkM34csHnXQtOqcb+Jzg==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-odd": "0.1.2",
			},
		},

		"is-number@3.0.0": {
			"integrity": "sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"kind-of": "3.2.2",
			},
		},

		"is-odd@0.1.2": {
			"integrity": "sha512-Ri7C2K7o5IrUU9UEI8losXJCCD/UtsaIrkR5sxIcFg4xQ9cRJXlWA5DQvTE0yDc0krvSNLsRGXN11UPS6KyfBw==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-number": "3.0.0",
			},
		},

		"kind-of@3.2.2": {
			"integrity": "sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-buffer": "1.1.6",
			},
		},

		"tg@file:vendor/tg.tgz": {
			"resolution": {"tarball": "file:vendor/tg.tgz"},
			"integrity": "sha512-fUAaKgSGFnfzqQAkwjP18tmoakTjOM1cGKf63Q/k0DkWt9qVXGc6XtHTsctvnYvz4UzpCQDiFiZuk8gOwnrfPQ==",
			"version": "1.0.0",
		},
	},
}
`

const OVERRIDE_TARBALL_LINK_INJECTED_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  is-number@3: 3.0.0

importers:

  .: {}

  apps/a:
    dependencies:
      is-even:
        specifier: 1.0.0
        version: 1.0.0
      lib:
        specifier: workspace:*
        version: link:../../packages/lib
      outside:
        specifier: link:../../outside
        version: link:../../outside
      tg:
        specifier: file:../../vendor/tg.tgz
        version: file:vendor/tg.tgz
    dependenciesMeta:
      lib:
        injected: true
    devDependencies:
      kind-of:
        specifier: 3.2.2
        version: 3.2.2
    optionalDependencies:
      is-buffer:
        specifier: 1.1.6
        version: 1.1.6

  packages/lib:
    dependencies:
      is-odd:
        specifier: 0.1.2
        version: 0.1.2

packages:

  is-buffer@1.1.6:
    resolution: {integrity: sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==}

  is-even@1.0.0:
    resolution: {integrity: sha512-LEhnkAdJqic4Dbqn58A0y52IXoHWlsueqQkKfMfdEnIYG8A1sm/GHidKkS6yvXlMoRrkM34csHnXQtOqcb+Jzg==}
    engines: {node: '>=0.10.0'}

  is-number@3.0.0:
    resolution: {integrity: sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg==}
    engines: {node: '>=0.10.0'}

  is-odd@0.1.2:
    resolution: {integrity: sha512-Ri7C2K7o5IrUU9UEI8losXJCCD/UtsaIrkR5sxIcFg4xQ9cRJXlWA5DQvTE0yDc0krvSNLsRGXN11UPS6KyfBw==}
    engines: {node: '>=0.10.0'}

  kind-of@3.2.2:
    resolution: {integrity: sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==}
    engines: {node: '>=0.10.0'}

  tg@file:vendor/tg.tgz:
    resolution: {integrity: sha512-fUAaKgSGFnfzqQAkwjP18tmoakTjOM1cGKf63Q/k0DkWt9qVXGc6XtHTsctvnYvz4UzpCQDiFiZuk8gOwnrfPQ==, tarball: file:vendor/tg.tgz}
    version: 1.0.0

snapshots:

  is-buffer@1.1.6: {}

  is-even@1.0.0:
    dependencies:
      is-odd: 0.1.2

  is-number@3.0.0:
    dependencies:
      kind-of: 3.2.2

  is-odd@0.1.2:
    dependencies:
      is-number: 3.0.0

  kind-of@3.2.2:
    dependencies:
      is-buffer: 1.1.6

  tg@file:vendor/tg.tgz: {}
`

const BELOW_PEER_PATCH_NAMED_CATALOG_V13 = `{
	"lockfileVersion": "13.0",

	"settings": {
		"autoInstallPeers": true,
		"excludeLinksFromLockfile": false,
		"catalogs": {
			"odd": {
				"is-odd": "3.0.1",
			},
		},
		"patchedDependencies": {
			"is-odd@3.0.1": "dfecd5118010d4e1a15e79bf77ba019b903176b335a94906e574da919afaf25f",
		},
	},

	"projects": {
		".": {},

		"apps/a": {
			"dependencies": {
				"@eslint/config-array": "0.18.0",
				"is-odd": "catalog:odd",
				"supports-color": "7.2.0",
			},
		},
	},

	"packages": {
		"@eslint/config-array@0.18.0": {
			"integrity": "sha512-fTxvnS1sRMu3+JjXwJG0j/i4RT9u4qJ+lqS/yCGap4lH4zZGzQ7tu+xZqQmcMZq5OBZDL4QRxQzRjkWcGt8IVw==",
			"engines": {"node": "^18.18.0 || ^20.9.0 || >=21.1.0"},
			"peerDependencies": {
				"supports-color": {
					"version": "7.2.0",
					"below": true,
				},
			},
			"dependencies": {
				"@eslint/object-schema": "2.1.7",
				"debug": "4.4.3",
				"minimatch": "3.1.5",
			},
		},

		"@eslint/object-schema@2.1.7": {
			"integrity": "sha512-VtAOaymWVfZcmZbp6E2mympDIHvyjXs/12LqWYjVw6qjrfF+VK+fyG33kChz3nnK+SU5/NeHOqrTEHS8sXO3OA==",
			"engines": {"node": "^18.18.0 || ^20.9.0 || >=21.1.0"},
		},

		"balanced-match@1.0.2": {
			"integrity": "sha512-3oSeUO0TMV67hN1AmbXsK4yaqU7tjiHlbxRDZOpH0KW9+CeX4bRAaX0Anxt0tx2MrpRpWwQaPwIlISEJhYU5Pw==",
		},

		"brace-expansion@1.1.22": {
			"integrity": "sha512-CKLDTuSsN0+r1ThM0WkzzBI7dnPI6xEGfa/JnVYIK9JNBA1N1NyPwXVHor//NKD/y3sDxp764sZdLhFK7pH8XQ==",
			"dependencies": {
				"balanced-match": "1.0.2",
				"concat-map": "0.0.1",
			},
		},

		"concat-map@0.0.1": {
			"integrity": "sha512-/Srv4dswyQNBfohGpz9o6Yb3Gz3SrUDqBH5rTuhGR7ahtlbYKnVxw2bCFMRljaA7EXHaXZ8wsHdodFvbkhKmqg==",
		},

		"debug@4.4.3": {
			"integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==",
			"engines": {"node": ">=6.0"},
			"peerDependencies": {
				"supports-color": {
					"specifier": "*",
					"version": "7.2.0",
					"optional": true,
				},
			},
			"dependencies": {
				"ms": "2.1.3",
			},
		},

		"has-flag@4.0.0": {
			"integrity": "sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==",
			"engines": {"node": ">=8"},
		},

		"is-number@6.0.0": {
			"integrity": "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==",
			"engines": {"node": ">=0.10.0"},
		},

		"is-odd@3.0.1": {
			"integrity": "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==",
			"engines": {"node": ">=4"},
			"dependencies": {
				"is-number": "6.0.0",
			},
		},

		"minimatch@3.1.5": {
			"integrity": "sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==",
			"dependencies": {
				"brace-expansion": "1.1.22",
			},
		},

		"ms@2.1.3": {
			"integrity": "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
		},

		"supports-color@7.2.0": {
			"integrity": "sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==",
			"engines": {"node": ">=8"},
			"dependencies": {
				"has-flag": "4.0.0",
			},
		},
	},
}
`

const BELOW_PEER_PATCH_NAMED_CATALOG_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

catalogs:
  odd:
    is-odd:
      specifier: 3.0.1
      version: 3.0.1

patchedDependencies:
  is-odd@3.0.1: dfecd5118010d4e1a15e79bf77ba019b903176b335a94906e574da919afaf25f

importers:

  .: {}

  apps/a:
    dependencies:
      '@eslint/config-array':
        specifier: 0.18.0
        version: 0.18.0(supports-color@7.2.0)
      is-odd:
        specifier: catalog:odd
        version: 3.0.1(patch_hash=dfecd5118010d4e1a15e79bf77ba019b903176b335a94906e574da919afaf25f)
      supports-color:
        specifier: 7.2.0
        version: 7.2.0

packages:

  '@eslint/config-array@0.18.0':
    resolution: {integrity: sha512-fTxvnS1sRMu3+JjXwJG0j/i4RT9u4qJ+lqS/yCGap4lH4zZGzQ7tu+xZqQmcMZq5OBZDL4QRxQzRjkWcGt8IVw==}
    engines: {node: ^18.18.0 || ^20.9.0 || >=21.1.0}

  '@eslint/object-schema@2.1.7':
    resolution: {integrity: sha512-VtAOaymWVfZcmZbp6E2mympDIHvyjXs/12LqWYjVw6qjrfF+VK+fyG33kChz3nnK+SU5/NeHOqrTEHS8sXO3OA==}
    engines: {node: ^18.18.0 || ^20.9.0 || >=21.1.0}

  balanced-match@1.0.2:
    resolution: {integrity: sha512-3oSeUO0TMV67hN1AmbXsK4yaqU7tjiHlbxRDZOpH0KW9+CeX4bRAaX0Anxt0tx2MrpRpWwQaPwIlISEJhYU5Pw==}

  brace-expansion@1.1.22:
    resolution: {integrity: sha512-CKLDTuSsN0+r1ThM0WkzzBI7dnPI6xEGfa/JnVYIK9JNBA1N1NyPwXVHor//NKD/y3sDxp764sZdLhFK7pH8XQ==}

  concat-map@0.0.1:
    resolution: {integrity: sha512-/Srv4dswyQNBfohGpz9o6Yb3Gz3SrUDqBH5rTuhGR7ahtlbYKnVxw2bCFMRljaA7EXHaXZ8wsHdodFvbkhKmqg==}

  debug@4.4.3:
    resolution: {integrity: sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==}
    engines: {node: '>=6.0'}
    peerDependencies:
      supports-color: '*'
    peerDependenciesMeta:
      supports-color:
        optional: true

  has-flag@4.0.0:
    resolution: {integrity: sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==}
    engines: {node: '>=8'}

  is-number@6.0.0:
    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}
    engines: {node: '>=0.10.0'}

  is-odd@3.0.1:
    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}
    engines: {node: '>=4'}

  minimatch@3.1.5:
    resolution: {integrity: sha512-VgjWUsnnT6n+NUk6eZq77zeFdpW2LWDzP6zFGrCbHXiYNul5Dzqk2HHQ5uFH2DNW5Xbp8+jVzaeNt94ssEEl4w==}

  ms@2.1.3:
    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}

  supports-color@7.2.0:
    resolution: {integrity: sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==}
    engines: {node: '>=8'}

snapshots:

  '@eslint/config-array@0.18.0(supports-color@7.2.0)':
    dependencies:
      '@eslint/object-schema': 2.1.7
      debug: 4.4.3(supports-color@7.2.0)
      minimatch: 3.1.5
    transitivePeerDependencies:
      - supports-color

  '@eslint/object-schema@2.1.7': {}

  balanced-match@1.0.2: {}

  brace-expansion@1.1.22:
    dependencies:
      balanced-match: 1.0.2
      concat-map: 0.0.1

  concat-map@0.0.1: {}

  debug@4.4.3(supports-color@7.2.0):
    dependencies:
      ms: 2.1.3
    optionalDependencies:
      supports-color: 7.2.0

  has-flag@4.0.0: {}

  is-number@6.0.0: {}

  is-odd@3.0.1(patch_hash=dfecd5118010d4e1a15e79bf77ba019b903176b335a94906e574da919afaf25f):
    dependencies:
      is-number: 6.0.0

  minimatch@3.1.5:
    dependencies:
      brace-expansion: 1.1.22

  ms@2.1.3: {}

  supports-color@7.2.0:
    dependencies:
      has-flag: 4.0.0
`

const CATALOG_NPM_ALIAS_V13 = `{
	"lockfileVersion": "13.0",

	"settings": {
		"autoInstallPeers": true,
		"excludeLinksFromLockfile": false,
		"catalogs": {
			"default": {
				"al": {
					"specifier": "npm:is-odd@^3.0.1",
					"version": "3.0.1",
				},
			},
		},
	},

	"projects": {
		".": {},

		"apps/a": {
			"dependencies": {
				"al": "catalog:",
			},
		},

		"apps/b": {
			"dependencies": {
				"is-even": "1.0.0",
			},
		},
	},

	"packages": {
		"is-buffer@1.1.6": {
			"integrity": "sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==",
		},

		"is-even@1.0.0": {
			"integrity": "sha512-LEhnkAdJqic4Dbqn58A0y52IXoHWlsueqQkKfMfdEnIYG8A1sm/GHidKkS6yvXlMoRrkM34csHnXQtOqcb+Jzg==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-odd": "0.1.2",
			},
		},

		"is-number@3.0.0": {
			"integrity": "sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"kind-of": "3.2.2",
			},
		},

		"is-number@6.0.0": {
			"integrity": "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==",
			"engines": {"node": ">=0.10.0"},
		},

		"is-odd@0.1.2": {
			"integrity": "sha512-Ri7C2K7o5IrUU9UEI8losXJCCD/UtsaIrkR5sxIcFg4xQ9cRJXlWA5DQvTE0yDc0krvSNLsRGXN11UPS6KyfBw==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-number": "3.0.0",
			},
		},

		"is-odd@3.0.1": {
			"integrity": "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==",
			"engines": {"node": ">=4"},
			"dependencies": {
				"is-number": "6.0.0",
			},
		},

		"kind-of@3.2.2": {
			"integrity": "sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==",
			"engines": {"node": ">=0.10.0"},
			"dependencies": {
				"is-buffer": "1.1.6",
			},
		},
	},
}
`

const CATALOG_NPM_ALIAS_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

catalogs:
  default:
    al:
      specifier: npm:is-odd@^3.0.1
      version: 3.0.1

importers:

  .: {}

  apps/a:
    dependencies:
      al:
        specifier: 'catalog:'
        version: is-odd@3.0.1

  apps/b:
    dependencies:
      is-even:
        specifier: 1.0.0
        version: 1.0.0

packages:

  is-buffer@1.1.6:
    resolution: {integrity: sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==}

  is-even@1.0.0:
    resolution: {integrity: sha512-LEhnkAdJqic4Dbqn58A0y52IXoHWlsueqQkKfMfdEnIYG8A1sm/GHidKkS6yvXlMoRrkM34csHnXQtOqcb+Jzg==}
    engines: {node: '>=0.10.0'}

  is-number@3.0.0:
    resolution: {integrity: sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg==}
    engines: {node: '>=0.10.0'}

  is-number@6.0.0:
    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}
    engines: {node: '>=0.10.0'}

  is-odd@0.1.2:
    resolution: {integrity: sha512-Ri7C2K7o5IrUU9UEI8losXJCCD/UtsaIrkR5sxIcFg4xQ9cRJXlWA5DQvTE0yDc0krvSNLsRGXN11UPS6KyfBw==}
    engines: {node: '>=0.10.0'}

  is-odd@3.0.1:
    resolution: {integrity: sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==}
    engines: {node: '>=4'}

  kind-of@3.2.2:
    resolution: {integrity: sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==}
    engines: {node: '>=0.10.0'}

snapshots:

  is-buffer@1.1.6: {}

  is-even@1.0.0:
    dependencies:
      is-odd: 0.1.2

  is-number@3.0.0:
    dependencies:
      kind-of: 3.2.2

  is-number@6.0.0: {}

  is-odd@0.1.2:
    dependencies:
      is-number: 3.0.0

  is-odd@3.0.1:
    dependencies:
      is-number: 6.0.0

  kind-of@3.2.2:
    dependencies:
      is-buffer: 1.1.6
`
