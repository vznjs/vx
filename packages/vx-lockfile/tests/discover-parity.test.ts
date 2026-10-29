// The edges `discover` reads from a lockfile, over the manifests that
// install wrote it from — every bucket, a peer that orders, a peer that
// would close a cycle (reach only), two peers on each other, a dependency
// ring and the root as a project. The lockfiles are real installs (bun
// 1.4.2, pnpm 10.28, npm 10.9, yarn 4). The expected lists are what core's
// manifest graph answered over the same manifests (language-agnostic core,
// PR 2's parity row), recorded when PR 3 deleted it: core reads no edge
// now, so these are the edges a run has. The rows after them pin where the
// lockfile says otherwise than a manifest read guesses: the edge is what
// was installed.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta, VxPlugin } from '@vzn/vx'
import { bun, npm, pnpm, yarn } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-parity-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type Manifests = Record<string, { name: string } & Record<string, unknown>>

/**
 * Core's metas for `manifests` (dir → manifest; `.` is the root project),
 * each written where the plugin reads it, and named here by its manifest
 * so the edge lists read by name.
 */
async function metas(manifests: Manifests): Promise<ProjectMeta[]> {
  return await Promise.all(
    Object.entries(manifests).map(async ([dir, pkg]) => {
      const abs = dir === '.' ? root : path.join(root, dir)
      await mkdir(abs, { recursive: true })
      await writeFile(path.join(abs, 'package.json'), JSON.stringify(pkg))
      return { name: pkg.name, dir: abs, configPath: null }
    }),
  )
}

/** Every `from → to` order edge and every edge of the transitive reach, by project name. */
async function pluginEdges(plugin: VxPlugin, file: string, text: string, projects: ProjectMeta[]) {
  await writeFile(path.join(root, file), text)
  const entries = await plugin.discover!({
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    projects,
    warn() {},
    worktreeChanges: async () => null,
  })
  const nameOf = new Map(projects.map((p) => [p.dir, p.name]))
  const order = new Map<string, string[]>()
  const near = new Map<string, string[]>()
  for (const e of entries) {
    const from = nameOf.get(e.dir)!
    order.set(
      from,
      (e.deps ?? []).map((d) => nameOf.get(d)!),
    )
    near.set(
      from,
      [...(e.deps ?? []), ...(e.reach ?? [])].map((d) => nameOf.get(d)!),
    )
  }
  const closure = (n: string): string[] => {
    const seen = new Set<string>()
    const stack = [...(near.get(n) ?? [])]
    while (stack.length > 0) {
      const c = stack.pop()!
      if (seen.has(c)) continue
      seen.add(c)
      stack.push(...(near.get(c) ?? []))
    }
    return [...seen]
  }
  return edgeLists(projects, (n) => order.get(n) ?? [], closure)
}

function edgeLists(
  projects: ProjectMeta[],
  order: (n: string) => readonly string[],
  reach: (n: string) => readonly string[],
) {
  const names = projects.map((p) => p.name)
  const list = (f: (n: string) => readonly string[]) =>
    names.flatMap((n) => f(n).map((d) => `${n} → ${d}`)).sort()
  return { order: list(order), reach: list(reach) }
}

/** The fixture each manager installed; npm, which has no `workspace:`, took `*`. */
function combined(any: string): Manifests {
  return {
    '.': { name: 'root', version: '1.0.0', devDependencies: { lib: any } },
    'packages/app': {
      name: 'app',
      version: '1.0.0',
      dependencies: { lib: any },
      devDependencies: { tool: any },
      optionalDependencies: { opt: any },
      peerDependencies: { peer: any },
    },
    'packages/lib': { name: 'lib', version: '1.0.0', dependencies: { 'is-number': '^7.0.0' } },
    'packages/tool': { name: 'tool', version: '1.0.0' },
    'packages/opt': { name: 'opt', version: '1.0.0' },
    'packages/peer': { name: 'peer', version: '1.0.0' },
    'packages/core': { name: 'core', version: '1.0.0', devDependencies: { devtools: any } },
    'packages/devtools': { name: 'devtools', version: '1.0.0', peerDependencies: { core: any } },
    'packages/x': { name: 'x', version: '1.0.0', peerDependencies: { y: any } },
    'packages/y': { name: 'y', version: '1.0.0', peerDependencies: { x: any } },
    'packages/ring-a': { name: 'ring-a', version: '1.0.0', dependencies: { 'ring-b': any } },
    'packages/ring-b': { name: 'ring-b', version: '1.0.0', dependencies: { 'ring-a': any } },
  }
}

const BUN = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
      "devDependencies": {
        "lib": "workspace:*",
      },
    },
    "packages/app": {
      "name": "app",
      "version": "1.0.0",
      "dependencies": {
        "lib": "workspace:*",
      },
      "devDependencies": {
        "tool": "workspace:*",
      },
      "optionalDependencies": {
        "opt": "workspace:*",
      },
      "peerDependencies": {
        "peer": "workspace:*",
      },
    },
    "packages/core": {
      "name": "core",
      "version": "1.0.0",
      "devDependencies": {
        "devtools": "workspace:*",
      },
    },
    "packages/devtools": {
      "name": "devtools",
      "version": "1.0.0",
      "peerDependencies": {
        "core": "workspace:*",
      },
    },
    "packages/lib": {
      "name": "lib",
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^7.0.0",
      },
    },
    "packages/opt": {
      "name": "opt",
      "version": "1.0.0",
    },
    "packages/peer": {
      "name": "peer",
      "version": "1.0.0",
    },
    "packages/ring-a": {
      "name": "ring-a",
      "version": "1.0.0",
      "dependencies": {
        "ring-b": "workspace:*",
      },
    },
    "packages/ring-b": {
      "name": "ring-b",
      "version": "1.0.0",
      "dependencies": {
        "ring-a": "workspace:*",
      },
    },
    "packages/tool": {
      "name": "tool",
      "version": "1.0.0",
    },
    "packages/x": {
      "name": "x",
      "version": "1.0.0",
      "peerDependencies": {
        "y": "workspace:*",
      },
    },
    "packages/y": {
      "name": "y",
      "version": "1.0.0",
      "peerDependencies": {
        "x": "workspace:*",
      },
    },
  },
  "packages": {
    "app": ["app@workspace:packages/app"],

    "core": ["core@workspace:packages/core"],

    "devtools": ["devtools@workspace:packages/devtools"],

    "is-number": ["is-number@7.0.0", "", {}, "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng=="],

    "lib": ["lib@workspace:packages/lib"],

    "opt": ["opt@workspace:packages/opt"],

    "peer": ["peer@workspace:packages/peer"],

    "ring-a": ["ring-a@workspace:packages/ring-a"],

    "ring-b": ["ring-b@workspace:packages/ring-b"],

    "tool": ["tool@workspace:packages/tool"],

    "x": ["x@workspace:packages/x"],

    "y": ["y@workspace:packages/y"],
  }
}
`

const PNPM = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      lib:
        specifier: workspace:*
        version: link:packages/lib

  packages/app:
    dependencies:
      lib:
        specifier: workspace:*
        version: link:../lib
      peer:
        specifier: workspace:*
        version: link:../peer
    devDependencies:
      tool:
        specifier: workspace:*
        version: link:../tool
    optionalDependencies:
      opt:
        specifier: workspace:*
        version: link:../opt

  packages/core:
    devDependencies:
      devtools:
        specifier: workspace:*
        version: link:../devtools

  packages/devtools:
    dependencies:
      core:
        specifier: workspace:*
        version: link:../core

  packages/lib:
    dependencies:
      is-number:
        specifier: ^7.0.0
        version: 7.0.0

  packages/opt: {}

  packages/peer: {}

  packages/ring-a:
    dependencies:
      ring-b:
        specifier: workspace:*
        version: link:../ring-b

  packages/ring-b:
    dependencies:
      ring-a:
        specifier: workspace:*
        version: link:../ring-a

  packages/tool: {}

  packages/x:
    dependencies:
      y:
        specifier: workspace:*
        version: link:../y

  packages/y:
    dependencies:
      x:
        specifier: workspace:*
        version: link:../x

packages:

  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}

snapshots:

  is-number@7.0.0: {}
`

const NPM = `{
  "name": "root",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "root",
      "version": "1.0.0",
      "workspaces": [
        "packages/*"
      ],
      "devDependencies": {
        "lib": "*"
      }
    },
    "node_modules/app": {
      "resolved": "packages/app",
      "link": true
    },
    "node_modules/core": {
      "resolved": "packages/core",
      "link": true
    },
    "node_modules/devtools": {
      "resolved": "packages/devtools",
      "link": true
    },
    "node_modules/is-number": {
      "version": "7.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      "integrity": "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
      "license": "MIT",
      "engines": {
        "node": ">=0.12.0"
      }
    },
    "node_modules/lib": {
      "resolved": "packages/lib",
      "link": true
    },
    "node_modules/opt": {
      "resolved": "packages/opt",
      "link": true
    },
    "node_modules/peer": {
      "resolved": "packages/peer",
      "link": true
    },
    "node_modules/ring-a": {
      "resolved": "packages/ring-a",
      "link": true
    },
    "node_modules/ring-b": {
      "resolved": "packages/ring-b",
      "link": true
    },
    "node_modules/tool": {
      "resolved": "packages/tool",
      "link": true
    },
    "node_modules/x": {
      "resolved": "packages/x",
      "link": true
    },
    "node_modules/y": {
      "resolved": "packages/y",
      "link": true
    },
    "packages/app": {
      "version": "1.0.0",
      "dependencies": {
        "lib": "*"
      },
      "devDependencies": {
        "tool": "*"
      },
      "optionalDependencies": {
        "opt": "*"
      },
      "peerDependencies": {
        "peer": "*"
      }
    },
    "packages/core": {
      "version": "1.0.0",
      "devDependencies": {
        "devtools": "*"
      }
    },
    "packages/devtools": {
      "version": "1.0.0",
      "peerDependencies": {
        "core": "*"
      }
    },
    "packages/lib": {
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^7.0.0"
      }
    },
    "packages/opt": {
      "version": "1.0.0"
    },
    "packages/peer": {
      "version": "1.0.0"
    },
    "packages/ring-a": {
      "version": "1.0.0",
      "dependencies": {
        "ring-b": "*"
      }
    },
    "packages/ring-b": {
      "version": "1.0.0",
      "dependencies": {
        "ring-a": "*"
      }
    },
    "packages/tool": {
      "version": "1.0.0"
    },
    "packages/x": {
      "version": "1.0.0",
      "peerDependencies": {
        "y": "*"
      }
    },
    "packages/y": {
      "version": "1.0.0",
      "peerDependencies": {
        "x": "*"
      }
    }
  }
}`

const YARN = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 10
  cacheKey: 10c0

"app@workspace:packages/app":
  version: 0.0.0-use.local
  resolution: "app@workspace:packages/app"
  dependencies:
    lib: "workspace:*"
    opt: "workspace:*"
    tool: "workspace:*"
  peerDependencies:
    peer: "workspace:*"
  dependenciesMeta:
    opt:
      optional: true
  languageName: unknown
  linkType: soft

"core@workspace:packages/core":
  version: 0.0.0-use.local
  resolution: "core@workspace:packages/core"
  dependencies:
    devtools: "workspace:*"
  languageName: unknown
  linkType: soft

"devtools@workspace:*, devtools@workspace:packages/devtools":
  version: 0.0.0-use.local
  resolution: "devtools@workspace:packages/devtools"
  peerDependencies:
    core: "workspace:*"
  languageName: unknown
  linkType: soft

"is-number@npm:^7.0.0":
  version: 7.0.0
  resolution: "is-number@npm:7.0.0"
  checksum: 10c0/b4686d0d3053146095ccd45346461bc8e53b80aeb7671cc52a4de02dbbf7dc0d1d2a986e2fe4ae206984b4d34ef37e8b795ebc4f4295c978373e6575e295d811
  languageName: node
  linkType: hard

"lib@workspace:*, lib@workspace:packages/lib":
  version: 0.0.0-use.local
  resolution: "lib@workspace:packages/lib"
  dependencies:
    is-number: "npm:^7.0.0"
  languageName: unknown
  linkType: soft

"opt@workspace:*, opt@workspace:packages/opt":
  version: 0.0.0-use.local
  resolution: "opt@workspace:packages/opt"
  languageName: unknown
  linkType: soft

"peer@workspace:packages/peer":
  version: 0.0.0-use.local
  resolution: "peer@workspace:packages/peer"
  languageName: unknown
  linkType: soft

"ring-a@workspace:*, ring-a@workspace:packages/ring-a":
  version: 0.0.0-use.local
  resolution: "ring-a@workspace:packages/ring-a"
  dependencies:
    ring-b: "workspace:*"
  languageName: unknown
  linkType: soft

"ring-b@workspace:*, ring-b@workspace:packages/ring-b":
  version: 0.0.0-use.local
  resolution: "ring-b@workspace:packages/ring-b"
  dependencies:
    ring-a: "workspace:*"
  languageName: unknown
  linkType: soft

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  dependencies:
    lib: "workspace:*"
  languageName: unknown
  linkType: soft

"tool@workspace:*, tool@workspace:packages/tool":
  version: 0.0.0-use.local
  resolution: "tool@workspace:packages/tool"
  languageName: unknown
  linkType: soft

"x@workspace:packages/x":
  version: 0.0.0-use.local
  resolution: "x@workspace:packages/x"
  peerDependencies:
    y: "workspace:*"
  languageName: unknown
  linkType: soft

"y@workspace:packages/y":
  version: 0.0.0-use.local
  resolution: "y@workspace:packages/y"
  peerDependencies:
    x: "workspace:*"
  languageName: unknown
  linkType: soft
`

/** The order edges and the transitive reach of `combined`, as core's manifest graph read them. */
const MANIFEST_GRAPH = {
  order: [
    'app → lib',
    'app → opt',
    'app → peer',
    'app → tool',
    'core → devtools',
    'ring-a → ring-b',
    'ring-b → ring-a',
    'root → lib',
    'x → y',
  ],
  reach: [
    'app → lib',
    'app → opt',
    'app → peer',
    'app → tool',
    'core → core',
    'core → devtools',
    'devtools → core',
    'devtools → devtools',
    'ring-a → ring-a',
    'ring-a → ring-b',
    'ring-b → ring-a',
    'ring-b → ring-b',
    'root → lib',
    'x → x',
    'x → y',
    'y → x',
    'y → y',
  ],
}

// The root installs lib at the root `node_modules`: every other project
// resolves it, and builds after it (Turbo #8364, #8465).
const ROOT_LINKED = ['core', 'devtools', 'opt', 'peer', 'ring-a', 'ring-b', 'tool', 'x', 'y'].map(
  (n) => `${n} → lib`,
)
const COMBINED = {
  order: [...MANIFEST_GRAPH.order, ...ROOT_LINKED].sort(),
  reach: [...MANIFEST_GRAPH.reach, ...ROOT_LINKED].sort(),
}

describe('plugin edges are the recorded graph over the installed manifests', () => {
  for (const [make, file, text, any] of [
    [bun, 'bun.lock', BUN, 'workspace:*'],
    [pnpm, 'pnpm-lock.yaml', PNPM, 'workspace:*'],
    [npm, 'package-lock.json', NPM, '*'],
    [yarn, 'yarn.lock', YARN, 'workspace:*'],
  ] as const) {
    it(`${make.name}()`, async () => {
      const projects = await metas(combined(any))
      expect(await pluginEdges(make(), file, text, projects)).toEqual(COMBINED)
    })
  }
})

// A spec the manager resolves past its layout: bun links a `workspace:`
// path or alias and a satisfied `npm:` alias though `packages` records no
// nested entry for it; yarn symlinks a `link:` path; yarn installs the
// registry copy a devDependency names over a workspace peer of that key.
describe('the recorded edges hold on specs a lockfile resolves past its layout', () => {
  const rows = [
    {
      title: 'bun(): a `workspace:` path and a `workspace:` alias link their target, not their key',
      make: bun,
      file: 'bun.lock',
      text: `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
    },
    "packages/acme-ui": {
      "name": "@acme/ui",
      "version": "1.2.0",
    },
    "packages/app": {
      "name": "app",
      "version": "1.0.0",
      "dependencies": {
        "luigi": "workspace:../waluigi",
        "ui": "workspace:@acme/ui@^1.0.0",
      },
    },
    "packages/luigi": {
      "name": "luigi",
      "version": "1.0.0",
    },
    "packages/ui": {
      "name": "ui",
      "version": "9.0.0",
    },
    "packages/waluigi": {
      "name": "waluigi",
      "version": "1.0.0",
    },
  },
  "packages": {
    "@acme/ui": ["@acme/ui@workspace:packages/acme-ui"],

    "app": ["app@workspace:packages/app"],

    "luigi": ["luigi@workspace:packages/luigi"],

    "ui": ["ui@workspace:packages/ui"],

    "waluigi": ["waluigi@workspace:packages/waluigi"],
  }
}
`,
      manifests: {
        'packages/app': {
          name: 'app',
          version: '1.0.0',
          dependencies: { luigi: 'workspace:../waluigi', ui: 'workspace:@acme/ui@^1.0.0' },
        },
        'packages/luigi': { name: 'luigi', version: '1.0.0' },
        'packages/waluigi': { name: 'waluigi', version: '1.0.0' },
        'packages/ui': { name: 'ui', version: '9.0.0' },
        'packages/acme-ui': { name: '@acme/ui', version: '1.2.0' },
      },
      edges: ['app → @acme/ui', 'app → waluigi'],
    },
    {
      title: 'bun(): a satisfied `npm:` alias links the workspace package it names',
      make: bun,
      file: 'bun.lock',
      text: `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
    },
    "packages/app": {
      "name": "app",
      "version": "1.0.0",
      "dependencies": {
        "d": "npm:is-number@^2.0.0",
      },
    },
    "packages/d": {
      "name": "d",
      "version": "2.0.0",
    },
    "packages/is-number": {
      "name": "is-number",
      "version": "2.0.0",
    },
  },
  "packages": {
    "app": ["app@workspace:packages/app"],

    "d": ["d@workspace:packages/d"],

    "is-number": ["is-number@workspace:packages/is-number"],
  }
}
`,
      manifests: {
        'packages/app': {
          name: 'app',
          version: '1.0.0',
          dependencies: { d: 'npm:is-number@^2.0.0' },
        },
        'packages/d': { name: 'd', version: '2.0.0' },
        'packages/is-number': { name: 'is-number', version: '2.0.0' },
      },
      edges: ['app → is-number'],
    },
    // vercel/turborepo#854: a `file:` path to a workspace's directory lost
    // its edge. Bun 1.4.4 and npm 10 link it as the workspace (lockfiles
    // those installs wrote for b → a, `"a": "file:../a"`).
    {
      title: 'bun(): a `file:` path to a workspace links it',
      make: bun,
      file: 'bun.lock',
      text: `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
    },
    "packages/a": {
      "name": "a",
      "version": "1.0.0",
    },
    "packages/b": {
      "name": "b",
      "version": "1.0.0",
      "dependencies": {
        "a": "file:../a",
      },
    },
  },
  "packages": {
    "a": ["a@workspace:packages/a"],

    "b": ["b@workspace:packages/b"],
  }
}
`,
      manifests: {
        'packages/a': { name: 'a', version: '1.0.0' },
        'packages/b': { name: 'b', version: '1.0.0', dependencies: { a: 'file:../a' } },
      },
      edges: ['b → a'],
    },
    {
      title: 'npm(): a `file:` path to a workspace links it',
      make: npm,
      file: 'package-lock.json',
      text: `{
  "name": "root",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "root", "workspaces": ["packages/*"] },
    "node_modules/a": { "resolved": "packages/a", "link": true },
    "node_modules/b": { "resolved": "packages/b", "link": true },
    "packages/a": { "version": "1.0.0" },
    "packages/b": { "version": "1.0.0", "dependencies": { "a": "file:../a" } }
  }
}
`,
      manifests: {
        '.': { name: 'root', workspaces: ['packages/*'] },
        'packages/a': { name: 'a', version: '1.0.0' },
        'packages/b': { name: 'b', version: '1.0.0', dependencies: { a: 'file:../a' } },
      },
      edges: ['b → a'],
    },
    {
      title: 'yarn(): a `link:` path links the workspace package it points at',
      make: yarn,
      file: 'yarn.lock',
      text: `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 10
  cacheKey: 10c0

"app@workspace:packages/app":
  version: 0.0.0-use.local
  resolution: "app@workspace:packages/app"
  dependencies:
    b: "link:../real-b"
  languageName: unknown
  linkType: soft

"b@link:../real-b::locator=app%40workspace%3Apackages%2Fapp":
  version: 0.0.0-use.local
  resolution: "b@link:../real-b::locator=app%40workspace%3Apackages%2Fapp"
  languageName: node
  linkType: soft

"b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  languageName: unknown
  linkType: soft

"real-b@workspace:packages/real-b":
  version: 0.0.0-use.local
  resolution: "real-b@workspace:packages/real-b"
  languageName: unknown
  linkType: soft

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`,
      manifests: {
        'packages/app': { name: 'app', version: '1.0.0', dependencies: { b: 'link:../real-b' } },
        'packages/b': { name: 'b', version: '2.0.0' },
        'packages/real-b': { name: 'real-b', version: '2.0.0' },
      },
      edges: ['app → real-b'],
    },
    {
      title:
        'yarn(): an installed registry entry, not a workspace peer of its key, decides the edge',
      make: yarn,
      file: 'yarn.lock',
      text: `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 10
  cacheKey: 10c0

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  dependencies:
    buffer: "npm:^6.0.3"
  peerDependencies:
    buffer: "workspace:*"
  languageName: unknown
  linkType: soft

"b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "b@workspace:packages/b"
  peerDependencies:
    buffer: ^6.0.0
  languageName: unknown
  linkType: soft

"base64-js@npm:^1.3.1":
  version: 1.5.1
  resolution: "base64-js@npm:1.5.1"
  checksum: 10c0/f23823513b63173a001030fae4f2dabe283b99a9d324ade3ad3d148e218134676f1ee8568c877cd79ec1c53158dcf2d2ba527a97c606618928ba99dd930102bf
  languageName: node
  linkType: hard

"buffer@npm:^6.0.3":
  version: 6.0.3
  resolution: "buffer@npm:6.0.3"
  dependencies:
    base64-js: "npm:^1.3.1"
    ieee754: "npm:^1.2.1"
  checksum: 10c0/2a905fbbcde73cc5d8bd18d1caa23715d5f83a5935867c2329f0ac06104204ba7947be098fe1317fbd8830e26090ff8e764f08cd14fefc977bb248c3487bcbd0
  languageName: node
  linkType: hard

"buffer@workspace:packages/buffer":
  version: 0.0.0-use.local
  resolution: "buffer@workspace:packages/buffer"
  languageName: unknown
  linkType: soft

"d@workspace:packages/d":
  version: 0.0.0-use.local
  resolution: "d@workspace:packages/d"
  dependencies:
    buffer: "npm:^6.0.3"
  peerDependencies:
    buffer: "workspace:*"
  languageName: unknown
  linkType: soft

"ieee754@npm:^1.2.1":
  version: 1.2.1
  resolution: "ieee754@npm:1.2.1"
  checksum: 10c0/b0782ef5e0935b9f12883a2e2aa37baa75da6e66ce6515c168697b42160807d9330de9a32ec1ed73149aea02e0d822e572bca6f1e22bdcbd2149e13b050b17bb
  languageName: node
  linkType: hard

"o@workspace:packages/o":
  version: 0.0.0-use.local
  resolution: "o@workspace:packages/o"
  dependencies:
    buffer: "npm:^6.0.3"
  peerDependencies:
    buffer: ^0.0.1
  dependenciesMeta:
    buffer:
      optional: true
  languageName: unknown
  linkType: soft

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`,
      manifests: {
        'packages/a': {
          name: 'a',
          version: '1.0.0',
          devDependencies: { buffer: '^6.0.3' },
          peerDependencies: { buffer: 'workspace:*' },
        },
        'packages/d': {
          name: 'd',
          version: '1.0.0',
          dependencies: { buffer: '^6.0.3' },
          peerDependencies: { buffer: 'workspace:*' },
        },
        'packages/o': {
          name: 'o',
          version: '1.0.0',
          optionalDependencies: { buffer: '^6.0.3' },
          peerDependencies: { buffer: '^0.0.1' },
        },
        'packages/b': { name: 'b', version: '1.0.0', peerDependencies: { buffer: '^6.0.0' } },
        'packages/buffer': { name: 'buffer', version: '0.0.1' },
      },
      edges: ['b → buffer'],
    },
  ] as const
  for (const row of rows) {
    it(row.title, async () => {
      const projects = await metas(row.manifests as Manifests)
      expect(await pluginEdges(row.make(), row.file, row.text, projects)).toEqual({
        order: [...row.edges],
        reach: [...row.edges],
      })
    })
  }
})

describe('where the lockfile is exact and a manifest read guesses', () => {
  it('pnpm installs a plain range from the registry, though the workspace package satisfies it', async () => {
    // pnpm 9+ links a workspace package only by `workspace:` (`linkWorkspacePackages`
    // is off by default); `other` got the registry is-number@2.1.0.
    const projects = await metas({
      'packages/myapp': {
        name: 'myapp',
        version: '1.0.0',
        dependencies: { 'is-number': '^1.0.0' },
      },
      'packages/other': {
        name: 'other',
        version: '1.0.0',
        dependencies: { 'is-number': '^2.0.0' },
      },
      'packages/is-number': { name: 'is-number', version: '2.0.0' },
    })
    // A manifest read guessed `other → is-number`.
    expect((await pluginEdges(pnpm(), 'pnpm-lock.yaml', D_PNPM, projects)).order).toEqual([])
  })

  it('pnpm(): a `workspace:<name>@<range>` alias links the package it names, not its alias', async () => {
    // Turbo #5569: pnpm records the dependency under its alias `ui`.
    const lock = `lockfileVersion: '9.0'

importers:

  .: {}

  packages/scope-ui: {}

  packages/ui: {}

  packages/web:
    dependencies:
      ui:
        specifier: workspace:@scope/ui@*
        version: link:../scope-ui
`
    const projects = await metas({
      'packages/web': {
        name: 'web',
        version: '1.0.0',
        dependencies: { ui: 'workspace:@scope/ui@*' },
      },
      'packages/scope-ui': { name: '@scope/ui', version: '1.0.0' },
      'packages/ui': { name: 'ui', version: '9.0.0' },
    })
    expect((await pluginEdges(pnpm(), 'pnpm-lock.yaml', lock, projects)).order).toEqual([
      'web → @scope/ui',
    ])
  })

  it('yarn packs a `file:` directory, a copy that is no link to the workspace package', async () => {
    const projects = await metas({
      'packages/app': { name: 'app', version: '1.0.0', dependencies: { a: 'file:../real-a' } },
      'packages/a': { name: 'a', version: '2.0.0' },
      'packages/real-a': { name: 'real-a', version: '2.0.0' },
    })
    // A manifest read guessed `app → real-a`.
    expect((await pluginEdges(yarn(), 'yarn.lock', D_YARN, projects)).order).toEqual([])
  })

  // pnpm injects a workspace package (`dependenciesMeta.<name>.injected`,
  // or pnpm 10 `injectWorkspacePackages` with `dedupeInjectedDeps: false`)
  // as a hard-linked copy of its directory and records `file:<dir>` where a
  // link is `link:`. Unlike yarn's packed copy, it is the workspace package
  // itself (pnpm re-syncs it after the package's scripts), so `^build`
  // must wait for it (vercel/turborepo#12073 keeps the same entries).
  for (const [gen, text] of [
    ['v9 (pnpm 9/10)', P_INJECTED_V9],
    ['v6 (pnpm 8)', P_INJECTED_V6],
    ['v5 (pnpm 7)', P_INJECTED_V5],
    // An injected package with peers is keyed per peer set: `(react@18.2.0)`, v5 `_react@18.2.0`.
    ['v9 with peers', P_INJECTED_V9.replaceAll('file:packages/b', 'file:packages/b(react@18.2.0)')],
    ['v5 with peers', P_INJECTED_V5.replaceAll('file:packages/b', 'file:packages/b_react@18.2.0')],
  ] as const) {
    it(`pnpm ${gen}: an injected workspace package (\`file:<dir>\`) is an edge`, async () => {
      const projects = await metas({
        'packages/a': {
          name: 'a',
          version: '1.0.0',
          dependencies: { b: 'workspace:*' },
          dependenciesMeta: { b: { injected: true } },
        },
        'packages/b': { name: 'b', version: '1.0.0' },
      })
      expect((await pluginEdges(pnpm(), 'pnpm-lock.yaml', text, projects)).order).toEqual(['a → b'])
    })
  }

  it('bun installs `dependencies` over a devDependency or an optional one of the same key', async () => {
    const projects = await metas({
      'packages/dev-met-prod-unmet': {
        name: 'dev-met-prod-unmet',
        version: '1.0.0',
        devDependencies: { 'is-number': '^2.0.0' },
        dependencies: { 'is-number': '^3.0.0' },
      },
      'packages/opt-met-prod-unmet': {
        name: 'opt-met-prod-unmet',
        version: '1.0.0',
        optionalDependencies: { 'is-number': '^2.0.0' },
        dependencies: { 'is-number': '^3.0.0' },
      },
      'packages/is-number': { name: 'is-number', version: '2.0.0' },
    })
    // A manifest read guessed both projects → is-number.
    expect((await pluginEdges(bun(), 'bun.lock', D_BUN, projects)).order).toEqual([])
  })

  it("npm resolves an `npm:` alias's key to the workspace package of that name", async () => {
    // `d: npm:is-number@^2.0.0` beside a workspace `d`: npm wrote no entry
    // for the alias, so `require('d')` from app finds the workspace d.
    const projects = await metas({
      'packages/app': {
        name: 'app',
        version: '1.0.0',
        dependencies: { d: 'npm:is-number@^2.0.0' },
      },
      'packages/d': { name: 'd', version: '2.0.0' },
      'packages/is-number': { name: 'is-number', version: '2.0.0' },
    })
    // A manifest read guessed `app → is-number`.
    expect((await pluginEdges(npm(), 'package-lock.json', D_NPM, projects)).order).toEqual([
      'app → d',
    ])
  })
})

const D_PNPM = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/is-number: {}

  packages/myapp:
    dependencies:
      is-number:
        specifier: ^1.0.0
        version: 1.1.2

  packages/other:
    dependencies:
      is-number:
        specifier: ^2.0.0
        version: 2.1.0

packages:

  is-buffer@1.1.6:
    resolution: {integrity: sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w==}

  is-number@1.1.2:
    resolution: {integrity: sha512-dRKHHq76sZAXFf823ziHIOx5fXbuV1IrR892LugLDmyEBVMZzGoske4sY6lf+l3YPH/VyWNiKzNDXAPiQhx9Yg==}
    engines: {node: '>=0.10.0'}

  is-number@2.1.0:
    resolution: {integrity: sha512-QUzH43Gfb9+5yckcrSA0VBDwEtDUchrk4F6tfJZQuNzDJbEDB9cZNzSfXGQ1jqmdDY/kl41lUOWM9syA8z8jlg==}
    engines: {node: '>=0.10.0'}

  kind-of@3.2.2:
    resolution: {integrity: sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ==}
    engines: {node: '>=0.10.0'}

snapshots:

  is-buffer@1.1.6: {}

  is-number@1.1.2: {}

  is-number@2.1.0:
    dependencies:
      kind-of: 3.2.2

  kind-of@3.2.2:
    dependencies:
      is-buffer: 1.1.6
`

const D_YARN = `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: 10
  cacheKey: 10c0

"a@file:../real-a::locator=app%40workspace%3Apackages%2Fapp":
  version: 2.0.0
  resolution: "a@file:../real-a#../real-a::hash=925882&locator=app%40workspace%3Apackages%2Fapp"
  checksum: 10c0/71f2ac2e70f8484251b868bf06e564f41f0ca809695a84358b20af411f63fb807d16b6de304458866fa196b9757e0aef2000920c1ff7913b259725b8efbd21a9
  languageName: node
  linkType: hard

"a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "a@workspace:packages/a"
  languageName: unknown
  linkType: soft

"app@workspace:packages/app":
  version: 0.0.0-use.local
  resolution: "app@workspace:packages/app"
  dependencies:
    a: "file:../real-a"
  languageName: unknown
  linkType: soft

"real-a@workspace:packages/real-a":
  version: 0.0.0-use.local
  resolution: "real-a@workspace:packages/real-a"
  languageName: unknown
  linkType: soft

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`

const D_BUN = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
    },
    "packages/dev-met-prod-unmet": {
      "name": "dev-met-prod-unmet",
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^3.0.0",
      },
      "devDependencies": {
        "is-number": "^2.0.0",
      },
    },
    "packages/is-number": {
      "name": "is-number",
      "version": "2.0.0",
    },
    "packages/opt-met-prod-unmet": {
      "name": "opt-met-prod-unmet",
      "version": "1.0.0",
      "dependencies": {
        "is-number": "^3.0.0",
      },
      "optionalDependencies": {
        "is-number": "^2.0.0",
      },
    },
  },
  "packages": {
    "dev-met-prod-unmet": ["dev-met-prod-unmet@workspace:packages/dev-met-prod-unmet"],

    "is-buffer": ["is-buffer@1.1.6", "", {}, "sha512-NcdALwpXkTm5Zvvbk7owOUSvVvBKDgKP5/ewfXEznmQFfs4ZRmanOeKBTjRVjka3QFoN6XJ+9F3USqfHqTaU5w=="],

    "is-number": ["is-number@workspace:packages/is-number"],

    "kind-of": ["kind-of@3.2.2", "", { "dependencies": { "is-buffer": "^1.1.5" } }, "sha512-NOW9QQXMoZGg/oqnVNoNTTIFEIid1627WCffUBJEdMxYApq7mNE7CpzucIPc+ZQg25Phej7IJSmX3hO+oblOtQ=="],

    "opt-met-prod-unmet": ["opt-met-prod-unmet@workspace:packages/opt-met-prod-unmet"],

    "dev-met-prod-unmet/is-number": ["is-number@3.0.0", "", { "dependencies": { "kind-of": "^3.0.2" } }, "sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg=="],

    "opt-met-prod-unmet/is-number": ["is-number@3.0.0", "", { "dependencies": { "kind-of": "^3.0.2" } }, "sha512-4cboCqIpliH+mAvFNegjZQ4kgKc3ZUhQVr3HvWbSh5q3WH2v82ct+T2Y1hdU5Gdtorx/cLifQjqCbL7bpznLTg=="],
  }
}
`

const D_NPM = `{
  "name": "root",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "root",
      "version": "1.0.0",
      "workspaces": [
        "packages/*"
      ]
    },
    "node_modules/app": {
      "resolved": "packages/app",
      "link": true
    },
    "node_modules/d": {
      "resolved": "packages/d",
      "link": true
    },
    "node_modules/is-number": {
      "resolved": "packages/is-number",
      "link": true
    },
    "packages/app": {
      "version": "1.0.0",
      "dependencies": {
        "d": "npm:is-number@^2.0.0"
      }
    },
    "packages/d": {
      "version": "2.0.0"
    },
    "packages/is-number": {
      "version": "2.0.0"
    }
  }
}`

// pnpm 10.28, `dedupeInjectedDeps: false`.
const P_INJECTED_V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/a:
    dependencies:
      b:
        specifier: workspace:*
        version: file:packages/b
    dependenciesMeta:
      b:
        injected: true

  packages/b: {}

packages:

  b@file:packages/b:
    resolution: {directory: packages/b, type: directory}

snapshots:

  b@file:packages/b: {}
`

const P_INJECTED_V6 = `lockfileVersion: '6.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  packages/a:
    dependencies:
      b:
        specifier: workspace:*
        version: file:packages/b
    dependenciesMeta:
      b:
        injected: true

  packages/b: {}

packages:

  file:packages/b:
    resolution: {directory: packages/b, type: directory}
    name: b
    dev: false
`

const P_INJECTED_V5 = `lockfileVersion: 5.4

importers:

  .:
    specifiers: {}

  packages/a:
    specifiers:
      b: workspace:*
    dependencies:
      b: file:packages/b
    dependenciesMeta:
      b:
        injected: true

  packages/b:
    specifiers: {}

packages:

  file:packages/b:
    resolution: {directory: packages/b, type: directory}
    name: b
    dev: false
`
