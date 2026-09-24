import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { PackageJson, ProjectMeta } from '../src/workspace/workspace.js'
import { dry, PARITY_TIMEOUT, planned } from './helpers/parity.js'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

function meta(name: string, deps: Record<string, string> = {}): ProjectMeta {
  return {
    name,
    dir: `/ws/${name}`,
    packageJson: { name, dependencies: deps },
    configPath: null,
  }
}

/** A manifest with a version and any dependency fields, at `/ws/<name>`. */
function pkg(
  name: string,
  version: string | undefined,
  fields: Omit<PackageJson, 'name' | 'version'> = {},
): ProjectMeta {
  return {
    name,
    dir: `/ws/${name}`,
    packageJson: { name, ...(version === undefined ? {} : { version }), ...fields },
    configPath: null,
  }
}

/** Every edge of both adjacencies, `from → to`, sorted. */
function edges(g: ReturnType<typeof buildPackageGraph>, names: readonly string[]) {
  return {
    order: names.flatMap((n) => g.directDeps(n).map((d) => `${n} → ${d}`)).sort(),
    reach: names.flatMap((n) => g.transitiveDeps(n).map((d) => `${n} → ${d}`)).sort(),
  }
}

describe('buildPackageGraph', () => {
  it('a package that names ITSELF is not its own dependency', () => {
    // A package.json listing its own name — in devDependencies to pull
    // its published self — is not exotic, and a self-loop here is a
    // `^build` that waits on itself: a task cycle reported far from the
    // manifest that caused it. BOTH doors carry the same guard
    // (`name !== p.name`), the manifest fields and the task edges, and
    // neither had a witness. This row takes both.
    const g = buildPackageGraph(
      [
        {
          name: 'self',
          dir: '/ws/self',
          configPath: null,
          packageJson: { name: 'self', devDependencies: { self: '*', other: '*' } },
        },
        meta('other'),
      ],
      // The task-edge door: a plugin claiming `self` depends on `self`.
      new Map([['self', ['self', 'other']]]),
    )

    expect(g.directDeps('self')).toEqual(['other'])
    expect(g.transitiveDeps('self')).toEqual(['other'])
    // And nothing lists itself as its own dependent, which is what would
    // make `--filter self...` select a cycle.
    expect(g.transitiveDependents('self')).toEqual([])
  })

  it('builds an empty graph from no projects', () => {
    const g = buildPackageGraph([])
    // No-projects graph still answers queries — they just return [].
    expect(g.transitiveDeps('anything')).toEqual([])
  })

  it('records direct workspace deps only when the dep is in the workspace', () => {
    const g = buildPackageGraph([meta('a', { b: 'workspace:*', external: '^1.0.0' }), meta('b')])
    // 'external' is not a workspace package — only 'b' counts.
    expect(g.transitiveDeps('a')).toEqual(['b'])
    expect(g.transitiveDeps('b')).toEqual([])
  })

  it('directDeps returns only immediate workspace deps, sorted', () => {
    const g = buildPackageGraph([
      meta('a', { c: 'workspace:*', b: 'workspace:*', external: '^1.0.0' }),
      meta('b', { c: 'workspace:*' }),
      meta('c'),
    ])
    expect(g.directDeps('a')).toEqual(['b', 'c'])
    expect(g.directDeps('b')).toEqual(['c'])
    expect(g.directDeps('c')).toEqual([])
    expect(g.directDeps('unknown')).toEqual([])
  })

  it('walks transitive deps and dedupes them', () => {
    const g = buildPackageGraph([
      meta('a', { b: 'workspace:*' }),
      meta('b', { c: 'workspace:*' }),
      meta('c'),
    ])
    expect(g.transitiveDeps('a').sort()).toEqual(['b', 'c'])
    expect(g.transitiveDeps('b')).toEqual(['c'])
    expect(g.transitiveDeps('c')).toEqual([])
  })

  it('does not loop forever on a workspace dep cycle', () => {
    const g = buildPackageGraph([meta('a', { b: 'workspace:*' }), meta('b', { a: 'workspace:*' })])
    // Just terminate; resulting set should include the other package.
    expect(g.transitiveDeps('a')).toContain('b')
    expect(g.transitiveDeps('b')).toContain('a')
  })

  it('a cycle does not poison the closure memo (results are query-order independent)', () => {
    // a → b → c → a, plus c → z. Computing a's closure first used to cache a
    // TRUNCATED closure for the nodes visited while a sat on the DFS stack
    // (the back-edge contributes nothing), so every later query read the
    // partial set. The closure must not depend on which node is asked first.
    const build = (): ReturnType<typeof buildPackageGraph> =>
      buildPackageGraph([
        meta('a', { b: 'workspace:*' }),
        meta('b', { c: 'workspace:*' }),
        meta('c', { a: 'workspace:*', z: 'workspace:*' }),
        meta('z'),
      ])
    const full = ['a', 'b', 'c', 'z']

    const aFirst = build()
    expect(aFirst.transitiveDeps('a')).toEqual(full)
    expect(aFirst.transitiveDeps('c')).toEqual(full)

    const cFirst = build()
    expect(cFirst.transitiveDeps('c')).toEqual(full)
    expect(cFirst.transitiveDeps('a')).toEqual(full)
  })

  it('a node outside the cycle still gets its full closure after a cycle query', () => {
    const g = buildPackageGraph([
      meta('top', { a: 'workspace:*' }),
      meta('a', { b: 'workspace:*' }),
      meta('b', { a: 'workspace:*' }),
      meta('leaf'),
    ])
    expect(g.transitiveDeps('a')).toEqual(['a', 'b'])
    expect(g.transitiveDeps('top')).toEqual(['a', 'b'])
  })

  it('transitiveDependents walks the reverse direction', () => {
    const g = buildPackageGraph([
      meta('a', { b: 'workspace:*' }),
      meta('b', { c: 'workspace:*' }),
      meta('c'),
      meta('lonely'),
    ])
    expect(g.transitiveDependents('c').sort()).toEqual(['a', 'b'])
    expect(g.transitiveDependents('b')).toEqual(['a'])
    expect(g.transitiveDependents('a')).toEqual([])
    expect(g.transitiveDependents('lonely')).toEqual([])
  })

  it('transitiveDependents terminates on a 2-node cycle and includes the other node', () => {
    // a ↔ b (each depends on the other). The reverse-edge accessor takes
    // the legacy DFS path (the bitset sweep bails on a cycle); the stack
    // guard must stop the walk. Mirrors the transitiveDeps cycle test.
    const g = buildPackageGraph([meta('a', { b: 'workspace:*' }), meta('b', { a: 'workspace:*' })])
    expect(g.transitiveDependents('a')).toContain('b')
    expect(g.transitiveDependents('b')).toContain('a')
  })

  it('reads all four dependency fields: a workspace peer orders a build too', () => {
    const m: ProjectMeta = {
      name: 'a',
      dir: '/ws/a',
      packageJson: {
        name: 'a',
        dependencies: { b: 'workspace:*' },
        devDependencies: { c: 'workspace:*' },
        peerDependencies: { d: 'workspace:*' },
        optionalDependencies: { e: 'workspace:*' },
      },
      configPath: null,
    }
    const g = buildPackageGraph([m, meta('b'), meta('c'), meta('d'), meta('e')])
    // A peer on a sibling is an import that resolves to the sibling's
    // build (every package manager links or hoists it): `^build` waits
    // on it (router's devtools-core peers on router-core, 2026-09-11),
    // and a change in it reaches `a` (`--affected`, `...d`).
    expect(g.directDeps('a')).toEqual(['b', 'c', 'd', 'e'])
    expect(g.transitiveDeps('a').sort()).toEqual(['b', 'c', 'd', 'e'])
    expect(g.transitiveDependents('d')).toEqual(['a'])
  })

  it('a peer stays reach only when the peer already depends on the package', () => {
    // core dev-depends on its devtools (tests), devtools PEERS on core:
    // the hard edge orders, the peer edge would close the loop.
    const g = buildPackageGraph([
      meta('core', { devtools: 'workspace:*' }),
      {
        name: 'devtools',
        dir: '/ws/devtools',
        packageJson: { name: 'devtools', peerDependencies: { core: 'workspace:*' } },
        configPath: null,
      },
    ])
    expect(g.directDeps('core')).toEqual(['devtools'])
    expect(g.directDeps('devtools')).toEqual([])
    expect(g.transitiveDeps('devtools').sort()).toEqual(['core', 'devtools'])
  })

  it('two packages peering on each other keep one order edge, in name order', () => {
    const peerOn = (name: string, peer: string): ProjectMeta => ({
      name,
      dir: `/ws/${name}`,
      packageJson: { name, peerDependencies: { [peer]: 'workspace:*' } },
      configPath: null,
    })
    // Whichever order the projects arrive in, `a → b` is the edge kept.
    for (const projects of [
      [peerOn('a', 'b'), peerOn('b', 'a')],
      [peerOn('b', 'a'), peerOn('a', 'b')],
    ]) {
      const g = buildPackageGraph(projects)
      expect(g.directDeps('a')).toEqual(['b'])
      expect(g.directDeps('b')).toEqual([])
      expect(g.transitiveDependents('a').sort()).toEqual(['a', 'b'])
    }
  })

  it('a peer that closes a cycle is no cycle for the build order (medusa, 2026-09-11)', () => {
    // medusa: analytics dev-depends on test-utils, test-utils PEERS on
    // medusa, medusa depends on analytics. Turbo reads no peers and runs
    // it; with the peer as an order edge `^build` was a task cycle.
    const g = buildPackageGraph([
      meta('analytics', { 'test-utils': 'workspace:*' }),
      {
        name: 'test-utils',
        dir: '/ws/test-utils',
        packageJson: { name: 'test-utils', peerDependencies: { medusa: 'workspace:*' } },
        configPath: null,
      },
      meta('medusa', { analytics: 'workspace:*' }),
    ])
    expect(g.directDeps('test-utils')).toEqual([])
    // Reach still closes the loop: a medusa change affects test-utils.
    expect(g.transitiveDependents('medusa').sort()).toEqual(['analytics', 'medusa', 'test-utils'])
  })

  // The spec rows. What each package manager installs was measured
  // against the registry with bun 1.4.2, npm 10.9, yarn 1.22 and pnpm 12
  // (2026-09-24): a workspace `is-number@2.9.0` beside the published
  // 2.1.0 and 7.0.0, one install per spec, then which copy
  // `require.resolve` found from the dependent.

  it('a `workspace:` path or alias links the package it points at, not its key (turborepo#6744)', () => {
    // bun and pnpm link `../waluigi` and the aliased `@acme/ui`; the keys
    // name two unrelated workspace packages.
    const g = buildPackageGraph([
      pkg('app', '1.0.0', {
        dependencies: { luigi: 'workspace:../waluigi', ui: 'workspace:@acme/ui@^1.0.0' },
      }),
      pkg('luigi', '1.0.0'),
      pkg('waluigi', '1.0.0'),
      pkg('ui', '9.0.0'),
      pkg('@acme/ui', '1.2.0'),
    ])
    expect(edges(g, ['app'])).toEqual({
      order: ['app → @acme/ui', 'app → waluigi'],
      reach: ['app → @acme/ui', 'app → waluigi'],
    })
    expect(g.transitiveDependents('luigi')).toEqual([])
    expect(g.transitiveDependents('ui')).toEqual([])
  })

  it('a `file:`, `link:`, `portal:` or bare path and a satisfied `npm:` alias link their target', () => {
    // In `app` every key names a workspace package too, which the target
    // is not; in `keyless` no key names one.
    const at = (name: string) => pkg(name, '2.0.0')
    const g = buildPackageGraph([
      pkg('app', '1.0.0', {
        dependencies: {
          a: 'file:../real-a',
          b: 'link:../real-b',
          c: 'portal:../real-c',
          d: 'npm:real-d@^2.0.0',
          // Unmet: npm installs the published real-e.
          e: 'npm:real-e@^3.0.0',
          // A tarball beside a package directory is not that package.
          f: 'file:../real-a.tgz',
          // A bare relative path is a directory to bun, npm and pnpm.
          g: '../real-g',
        },
      }),
      pkg('keyless', '1.0.0', {
        dependencies: {
          'x-ws': 'workspace:../real-a',
          'x-npm': 'npm:real-b',
          'x-file': 'file:../real-c',
          'x-link': 'link:../real-d',
          'x-portal': 'portal:../real-e',
          'x-dot': './../real-g',
          'x-abs': '/ws/real-h',
          'x-registry': '^2.0.0',
        },
      }),
      ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(at),
      ...['real-a', 'real-b', 'real-c', 'real-d', 'real-e', 'real-g', 'real-h'].map(at),
    ])
    expect(edges(g, ['app', 'keyless']).order).toEqual([
      'app → real-a',
      'app → real-b',
      'app → real-c',
      'app → real-d',
      'app → real-g',
      'keyless → real-a',
      'keyless → real-b',
      'keyless → real-c',
      'keyless → real-d',
      'keyless → real-e',
      'keyless → real-g',
      'keyless → real-h',
    ])
  })

  it('a range the local version does not satisfy is a registry dependency (turborepo#4214)', () => {
    // bun, npm and yarn install `shared@^1.0.0` from the registry when the
    // workspace's `shared` is 2.0.0, and link it for `^2.0.0`, padded or not.
    const g = buildPackageGraph([
      pkg('myapp', '1.0.0', { dependencies: { shared: '^1.0.0' } }),
      pkg('other', '1.0.0', { dependencies: { shared: '^2.0.0' } }),
      pkg('padded', '1.0.0', { dependencies: { shared: ' ^2.0.0 ' } }),
      pkg('shared', '2.0.0'),
    ])
    expect(edges(g, ['myapp', 'other', 'padded', 'shared'])).toEqual({
      order: ['other → shared', 'padded → shared'],
      reach: ['other → shared', 'padded → shared'],
    })
    // `--affected` and `...shared` walk this set.
    expect(g.transitiveDependents('shared')).toEqual(['other', 'padded'])
  })

  it('an installed entry, not a peer on the same key, decides the edge (turborepo#12640)', () => {
    // `a` dev-depends on the registry `buffer@^6` and peers on the
    // workspace's: all four install the registry copy, and the same for a
    // `dependencies` (`d`) or `optionalDependencies` (`o`) entry. A peer
    // alone resolves to the hoisted workspace copy whatever its range or
    // tag (`b`, `c`: bun and yarn), and so whatever its spec (`u`).
    const g = buildPackageGraph([
      pkg('a', '1.0.0', {
        devDependencies: { buffer: '^6.0.3' },
        peerDependencies: { buffer: 'workspace:*' },
      }),
      pkg('d', '1.0.0', {
        dependencies: { buffer: '^6.0.3' },
        peerDependencies: { buffer: 'workspace:*' },
      }),
      pkg('o', '1.0.0', {
        optionalDependencies: { buffer: '^6.0.3' },
        peerDependencies: { buffer: '^0.0.1' },
      }),
      pkg('b', '1.0.0', { peerDependencies: { buffer: '^6.0.0' } }),
      pkg('c', '1.0.0', { peerDependencies: { buffer: 'next' } }),
      pkg('u', '1.0.0', { peerDependencies: { buffer: 'github:feross/buffer' } }),
      pkg('buffer', '0.0.1'),
    ])
    expect(edges(g, ['a', 'd', 'o', 'b', 'c', 'u', 'buffer'])).toEqual({
      order: ['b → buffer', 'c → buffer', 'u → buffer'],
      reach: ['b → buffer', 'c → buffer', 'u → buffer'],
    })
    expect(g.transitiveDependents('buffer')).toEqual(['b', 'c', 'u'])
  })

  it('a key in two installed fields links when either precedence order installs the local copy', () => {
    // bun and npm install devDependencies over optionalDependencies over
    // dependencies; yarn and pnpm optionalDependencies over dependencies
    // over devDependencies. Only a key BOTH orders take from the registry
    // is no edge.
    const two = (a: keyof PackageJson, aRange: string, b: keyof PackageJson, bRange: string) => ({
      [a]: { lib: aRange },
      [b]: { lib: bRange },
    })
    const g = buildPackageGraph([
      pkg(
        'opt-unmet-prod-met',
        '1.0.0',
        two('optionalDependencies', '^2.0.0', 'dependencies', '^1.0.0'),
      ),
      pkg(
        'opt-met-prod-unmet',
        '1.0.0',
        two('optionalDependencies', '^1.0.0', 'dependencies', '^2.0.0'),
      ),
      pkg(
        'dev-met-prod-unmet',
        '1.0.0',
        two('devDependencies', '^1.0.0', 'dependencies', '^2.0.0'),
      ),
      pkg(
        'dev-unmet-prod-met',
        '1.0.0',
        two('devDependencies', '^2.0.0', 'dependencies', '^1.0.0'),
      ),
      pkg(
        'dev-met-opt-unmet',
        '1.0.0',
        two('devDependencies', '^1.0.0', 'optionalDependencies', '^2.0.0'),
      ),
      pkg(
        'dev-unmet-opt-met',
        '1.0.0',
        two('devDependencies', '^2.0.0', 'optionalDependencies', '^1.0.0'),
      ),
      pkg(
        'dev-unmet-prod-unmet',
        '1.0.0',
        two('devDependencies', '^2.0.0', 'dependencies', '^3.0.0'),
      ),
      pkg('prod-met-under-both', '1.0.0', {
        ...two('devDependencies', '^2.0.0', 'optionalDependencies', '^2.0.0'),
        dependencies: { lib: '^1.0.0' },
      }),
      pkg('lib', '1.0.0'),
    ])
    const names = [
      'opt-unmet-prod-met',
      'opt-met-prod-unmet',
      'dev-met-prod-unmet',
      'dev-unmet-prod-met',
      'dev-met-opt-unmet',
      'dev-unmet-opt-met',
      'dev-unmet-prod-unmet',
      'prod-met-under-both',
    ]
    expect(edges(g, names).order).toEqual([
      'dev-met-opt-unmet → lib',
      'dev-met-prod-unmet → lib',
      'dev-unmet-opt-met → lib',
      'dev-unmet-prod-met → lib',
      'opt-met-prod-unmet → lib',
    ])
  })

  it('`*` and `workspace:^` take any version; a tag, a URL or an unmet `workspace:` range do not', () => {
    // `*` linked a prerelease in bun and npm; a versionless package
    // satisfies `*` alone; `latest` came from the registry in all four.
    const g = buildPackageGraph([
      pkg('any', '1.0.0', { dependencies: { bare: '*', pre: '', lib: 'workspace:^' } }),
      pkg('ranged', '1.0.0', {
        dependencies: { bare: '^0.0.0', pre: '^2.0.0', lib: 'workspace:^2.0.0' },
      }),
      pkg('met', '1.0.0', { dependencies: { lib: 'workspace:~1.4.0', pre: '>=2.0.0-0' } }),
      pkg('remote', '1.0.0', {
        dependencies: {
          lib: 'latest',
          bare: 'github:acme/bare',
          pre: 'https://example.com/pre.tgz',
          aliased: 'npm:lib@latest',
        },
      }),
      // npm ANDs the two comparators (1.x and 2.x: nothing); Bun 1.4.2
      // ORs them, so the graph never hands it this shape.
      pkg('odd', '1.0.0', { dependencies: { lib: '1 2' } }),
      // npm's other spelling of `*`, for a released version only.
      pkg('wild', '1.0.0', { dependencies: { lib: 'x.x', pre: 'x' } }),
      pkg('bare', undefined),
      pkg('pre', '2.0.0-beta.1'),
      pkg('lib', '1.4.2'),
    ])
    expect(edges(g, ['any', 'ranged', 'met', 'remote', 'odd', 'wild']).order).toEqual([
      'any → bare',
      'any → lib',
      'any → pre',
      'met → lib',
      'met → pre',
      'wild → lib',
    ])
  })

  it('a `catalog:` entry keeps the edge its key names (turborepo#10785)', () => {
    // The catalog's range lives in pnpm-workspace.yaml or bun's root
    // manifest, which the graph does not read.
    const g = buildPackageGraph([
      pkg('app-a', '1.0.0', {
        dependencies: { 'pkg-b': 'catalog:', react: 'catalog:' },
        peerDependencies: { 'react-dom': 'latest' },
      }),
      pkg('pkg-b', '1.0.0'),
    ])
    expect(g.directDeps('app-a')).toEqual(['pkg-b'])
    expect(g.transitiveDeps('app-a')).toEqual(['pkg-b'])
  })
})

describe('the planner reads the same edges', () => {
  it(
    '`vx run --dry=json`, `...pkg` and `--affected` follow the linked package, not the key',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-pkg-graph-specs-' })
      try {
        const add = async (name: string, version: string, fields: object = {}): Promise<void> => {
          const dir = path.join(root, 'packages', name)
          await mkdir(dir, { recursive: true })
          await writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({ name, version, ...fields }, null, 2),
          )
          await writeFile(
            path.join(dir, 'vx.config.mjs'),
            `export default {
              tasks: { build: { exec: { command: 'true' }, dependsOn: ['^build'] } },
            }
            `,
          )
        }
        await add('app', '1.0.0', { dependencies: { luigi: 'workspace:../waluigi' } })
        await add('luigi', '1.0.0')
        await add('waluigi', '1.0.0')
        await add('myapp', '1.0.0', { dependencies: { shared: '^1.0.0' } })
        await add('shared', '2.0.0')
        await add('a', '1.0.0', {
          devDependencies: { buffer: '^6.0.3' },
          peerDependencies: { buffer: 'workspace:*' },
        })
        await add('buffer', '0.0.1')
        const git = gitIn(root)
        git('add', '-A')
        git('commit', '-q', '-m', 'init')

        const app = await dry(root, ['build', '--filter', 'app'])
        expect(app.map((t) => [t.id, t.deps])).toEqual([
          ['app#build', ['waluigi#build']],
          ['waluigi#build', []],
        ])
        expect(await planned(root, ['build', '--filter', 'myapp'])).toEqual(['myapp#build'])
        expect(await planned(root, ['build', '--filter', 'a'])).toEqual(['a#build'])
        expect(await planned(root, ['build', '--filter', '...waluigi'])).toEqual([
          'app#build',
          'waluigi#build',
        ])
        await writeFile(path.join(root, 'packages', 'shared', 'changed.txt'), 'x\n')
        await writeFile(path.join(root, 'packages', 'buffer', 'changed.txt'), 'x\n')
        expect(await planned(root, ['build', '--affected=HEAD'])).toEqual([
          'buffer#build',
          'shared#build',
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    PARITY_TIMEOUT,
  )
})
