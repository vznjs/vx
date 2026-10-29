// package-lock.json (v2/v3): per-workspace digests through npm's nested
// node_modules layout and workspace links, and the plugin end to end.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type Logger } from '@vzn/vx'
import { planRun } from '../../vx/tests/helpers/orchestrator.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { affectedIds, commitAll, moved } from './helpers/affected.js'
import { npm } from '../src/index.js'
import { importerDigests, importerLinks, parseLockfile } from '../src/npm.js'
import { lowHalfGlobals } from './helpers/low-half.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

function silent(): Logger {
  return {
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status() {},
  } as never
}

/**
 * `a` → foo → bar (hoisted); `b` → baz and its own nested bar; `c` → the
 * workspace package `b` through the `node_modules/b` link.
 */
function lock(
  opts: { bar?: string; baz?: string; nestedBar?: string; overrides?: string; ts?: string } = {},
): string {
  const bar = opts.bar ?? '2.0.0'
  const ts = opts.ts ?? '5.0.0'
  const baz = opts.baz ?? '3.0.0'
  const nested = opts.nestedBar ?? '1.0.0'
  return JSON.stringify(
    {
      name: 'ws',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'ws',
          workspaces: ['packages/*'],
          devDependencies: { typescript: '^5' },
          ...(opts.overrides === undefined ? {} : { overrides: { zod: opts.overrides } }),
        },
        'node_modules/a': { resolved: 'packages/a', link: true },
        'node_modules/b': { resolved: 'packages/b', link: true },
        'node_modules/c': { resolved: 'packages/c', link: true },
        'node_modules/bar': {
          version: bar,
          resolved: `https://r/bar-${bar}.tgz`,
          integrity: `sha512-bar${bar}`,
        },
        'node_modules/baz': {
          version: baz,
          resolved: `https://r/baz-${baz}.tgz`,
          integrity: `sha512-baz${baz}`,
        },
        'node_modules/foo': {
          version: '1.0.0',
          resolved: 'https://r/foo-1.0.0.tgz',
          integrity: 'sha512-foo',
          dependencies: { bar: '^2' },
        },
        'node_modules/typescript': {
          version: ts,
          resolved: `https://r/ts-${ts}.tgz`,
          integrity: `sha512-ts${ts}`,
        },
        'packages/a': { name: 'a', version: '1.0.0', dependencies: { foo: '^1' } },
        'packages/b': { name: 'b', version: '1.0.0', dependencies: { baz: '^3', bar: '^1' } },
        'packages/b/node_modules/bar': {
          version: nested,
          resolved: `https://r/bar-${nested}.tgz`,
          integrity: `sha512-bar${nested}`,
        },
        'packages/c': { name: 'c', version: '1.0.0', dependencies: { b: '^1' } },
      },
    },
    null,
    2,
  )
}

const digests = (text: string) => importerDigests(parseLockfile(text))

describe('workspace digests (npm)', () => {
  it('two lockfile globals whose digests share a low half still part the digests (item 682)', () => {
    // Folded as a seed, Bun's xxHash3 would read only the low half of the
    // global's digest and the two would agree.
    const parsed = parseLockfile(lock())
    const [g1, g2] = lowHalfGlobals()
    const a = importerDigests({ ...parsed, global: g1 })
    const b = importerDigests({ ...parsed, global: g2 })
    expect(a.get('packages/a')).not.toBe(b.get('packages/a'))
  })

  it('a hoisted bump moves the workspaces that reach it and no other', () => {
    const before = digests(lock())
    const after = digests(lock({ bar: '2.0.1' }))
    expect([...before.keys()]).toEqual(['.', 'packages/a', 'packages/b', 'packages/c'])
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    expect(after.get('packages/b')).toBe(before.get('packages/b'))
    expect(after.get('.')).toBe(before.get('.'))
  })

  it('a nested version moves only the workspace it is nested under', () => {
    const before = digests(lock())
    const after = digests(lock({ nestedBar: '1.0.1' }))
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    expect(after.get('packages/a')).toBe(before.get('packages/a'))
  })

  it("a workspace link folds the linked workspace's reach", () => {
    const before = digests(lock())
    const after = digests(lock({ baz: '3.0.1' }))
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    expect(after.get('packages/c')).not.toBe(before.get('packages/c'))
    expect(after.get('packages/a')).toBe(before.get('packages/a'))
  })

  it('root overrides alone move no workspace: what they force is the entry (D-142)', () => {
    const before = digests(lock())
    const after = digests(lock({ overrides: '4.0.0' }))
    for (const dir of before.keys()) expect(after.get(dir)).toBe(before.get(dir))
  })

  it("the root's and a workspace's own version move no digest: npm installs nothing new", () => {
    // A release bump of the root's version re-keyed every task in the
    // workspace, the root's digest being in every key, with node_modules
    // unchanged. Bun and pnpm record no importer version.
    const bump = (text: string): string => {
      const doc = JSON.parse(text)
      doc.packages[''].version = '2.0.0'
      doc.packages['packages/b'].version = '1.0.1'
      return JSON.stringify(doc, null, 2)
    }
    const before = digests(lock())
    const after = digests(bump(lock()))
    for (const dir of before.keys()) expect(after.get(dir)).toBe(before.get(dir))
  })

  it('refuses what is not an npm v2+ lockfile', () => {
    expect(() => parseLockfile('{"name":"x"}')).toThrow(/no lockfileVersion/)
    expect(() => parseLockfile('{"lockfileVersion":1,"dependencies":{}}')).toThrow(
      /lockfileVersion 1 has no/,
    )
    expect(() => parseLockfile('nope')).toThrow(/JSON Parse error/)
  })
})

// What moves a digest, one input at a time (item 798's rows for bun.lock):
// an input the digest does not read is a stale hit on every run changing it.
it('a root with no workspaces has none: a file: directory is hashed, not a project', () => {
  // As npm 10 wrote it for `"dep": "file:./vendor/dep"` in a one-package
  // repo. Every entry outside node_modules read as a workspace there, so
  // vendor/dep became a project and its content left the key.
  const lock = parseLockfile(
    JSON.stringify({
      name: 'r',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'r', dependencies: { dep: 'file:./vendor/dep' } },
        'node_modules/dep': { resolved: 'vendor/dep', link: true },
        'vendor/dep': { version: '1.0.0' },
      },
    }),
  )
  expect(lock.fileDirs).toEqual(['vendor/dep'])
  expect([...importerLinks(lock).keys()]).toEqual(['.'])
})

describe('every input the npm digest must read', () => {
  const doc = (packages: Record<string, unknown>) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'ws', workspaces: ['packages/*'] }, ...packages },
    })
  const movedDirs = (before: string, after: string): string[] => {
    const b = digests(before)
    const a = digests(after)
    return [...a.keys()].filter((k) => a.get(k) !== b.get(k))
  }

  it('an optional and a peer dependency are followed like any other', () => {
    for (const field of ['optionalDependencies', 'peerDependencies']) {
      const text = (v: string) =>
        doc({
          'packages/a': { name: 'a', [field]: { opt: '^1' } },
          'node_modules/opt': { version: v, resolved: `https://r/opt-${v}`, integrity: `sha-${v}` },
        })
      expect(movedDirs(text('1.0.0'), text('1.0.1'))).toEqual(['packages/a'])
    }
  })

  it.each([
    ['version', { version: '1.0.1' }],
    ['resolved', { resolved: 'https://mirror/x-1.0.0.tgz' }],
    ['integrity', { integrity: 'sha512-other' }],
  ])('the %s alone moves the package', (_, change) => {
    const text = (over: Record<string, string>) =>
      doc({
        'packages/a': { name: 'a', dependencies: { x: '^1' } },
        'node_modules/x': {
          version: '1.0.0',
          resolved: 'https://r/x-1.0.0.tgz',
          integrity: 'sha512-x',
          ...over,
        },
      })
    expect(movedDirs(text({}), text(change))).toEqual(['packages/a'])
  })

  it('a dependency resolves at the nearest ancestor that holds it, level by level', () => {
    const text = (v: string) =>
      doc({
        'packages/a': { name: 'a', dependencies: { x: '^1' } },
        'node_modules/x': { version: '1.0.0', integrity: 'x', dependencies: { y: '^1' } },
        'node_modules/x/node_modules/y': {
          version: '1.0.0',
          integrity: 'y',
          dependencies: { z: '^1' },
        },
        'node_modules/x/node_modules/z': { version: v, integrity: `z${v}` },
        'node_modules/z': { version: '9.0.0', integrity: 'z9' },
      })
    expect(movedDirs(text('1.0.0'), text('1.0.1'))).toEqual(['packages/a'])
  })

  it('an unresolved dependency and a dangling link still fold what they name', () => {
    const spec = (s: string) => doc({ 'packages/a': { name: 'a', dependencies: { ghost: s } } })
    expect(movedDirs(spec('^1'), spec('^2'))).toEqual(['packages/a'])
    const link = (to: string) =>
      doc({
        'packages/a': { name: 'a', dependencies: { l: '*' } },
        'node_modules/l': { link: true, resolved: to },
      })
    expect(movedDirs(link('packages/gone-1'), link('packages/gone-2'))).toEqual(['packages/a'])
  })
  // A root that names no `workspaces` has none: every entry outside
  // node_modules is a `file:` directory npm links. Each was taken for a
  // workspace, so its content was never hashed and an edit in it replayed
  // the root's stale output.
  it('with no workspaces, a `file:` directory is content, not a workspace', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'r', version: '1.0.0', dependencies: { dep: 'file:vendor/dep' } },
        'node_modules/dep': { resolved: 'vendor/dep', link: true },
        'vendor/dep': { version: '1.0.0' },
      },
    })
    const lock = parseLockfile(text)
    const one = importerDigests(lock, new Map([['vendor/dep', 'v1']]))
    const two = importerDigests(lock, new Map([['vendor/dep', 'v2']]))
    expect({
      fileDirs: lock.fileDirs,
      importers: [...one.keys()],
      moved: one.get('.') !== two.get('.'),
    }).toEqual({ fileDirs: ['vendor/dep'], importers: ['.'], moved: true })
  })
  // npm honours a `!` workspace glob. Read as a glob of its own, it
  // matched every other path, so a `file:` directory was a workspace and
  // its content was never hashed (the shape npm 10.9 wrote).
  it('a `!` workspace glob excludes; it does not make every other entry a workspace', () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'r', workspaces: ['packages/*', '!packages/x'] },
        'node_modules/a': { resolved: 'packages/a', link: true },
        'node_modules/dep': { resolved: 'vendor/dep', link: true },
        'packages/a': { version: '1.0.0', dependencies: { dep: 'file:../../vendor/dep' } },
        'vendor/dep': { version: '1.0.0' },
      },
    })
    const lock = parseLockfile(text)
    const one = importerDigests(lock, new Map([['vendor/dep', 'v1']]))
    const two = importerDigests(lock, new Map([['vendor/dep', 'v2']]))
    expect({
      fileDirs: lock.fileDirs,
      importers: [...one.keys()].sort(),
      moved: one.get('packages/a') !== two.get('packages/a'),
    }).toEqual({ fileDirs: ['vendor/dep'], importers: ['.', 'packages/a'], moved: true })
  })

  it("two workspaces' own nested versions of one package each move only their workspace (vercel/turborepo#10988)", () => {
    // Turbo's issue-10985 fixture: app-one nests next 14, app-two next 15,
    // both reach @repo/components, whose next is a peer.
    const text = (one: string, two: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'monorepo', workspaces: ['apps/*', 'packages/*'] },
          'node_modules/next': { version: '14.2.5', integrity: 'sha512-top' },
          'node_modules/@repo/components': { resolved: 'packages/components', link: true },
          'apps/app-one': {
            name: 'app-one',
            dependencies: { '@repo/components': '*', next: '^14.0.0' },
          },
          'apps/app-one/node_modules/next': { version: '14.2.5', integrity: `sha512-${one}` },
          'apps/app-two': {
            name: 'app-two',
            dependencies: { '@repo/components': '*', next: '^15.0.0' },
          },
          'apps/app-two/node_modules/next': { version: '15.0.0', integrity: `sha512-${two}` },
          'packages/components': {
            name: '@repo/components',
            peerDependencies: { next: '^14 || ^15' },
          },
        },
      })
    expect(movedDirs(text('a', 'b'), text('a', 'b2'))).toEqual(['apps/app-two'])
    expect(movedDirs(text('a', 'b'), text('a2', 'b'))).toEqual(['apps/app-one'])
  })

  it("a dependency nested two levels under a workspace's package is in its reach (vercel/turborepo#12464)", () => {
    // npm install-strategy=shallow: app-a/chai → its own nested deep-eql;
    // pkg-b keeps an older chai of its own.
    const text = (eql: string, chaiB: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'monorepo', workspaces: ['apps/*', 'packages/*'] },
          'node_modules/app-a': { resolved: 'apps/app-a', link: true },
          'node_modules/pkg-b': { resolved: 'packages/pkg-b', link: true },
          'apps/app-a': { name: 'app-a', dependencies: { 'pkg-b': '*', chai: '^5.0.0' } },
          'apps/app-a/node_modules/chai': {
            version: '5.3.3',
            dependencies: { 'deep-eql': '^5.0.0' },
          },
          'apps/app-a/node_modules/chai/node_modules/deep-eql': {
            version: eql,
            integrity: `sha512-${eql}`,
          },
          'packages/pkg-b': { name: 'pkg-b', devDependencies: { chai: '^4.0.0' } },
          'packages/pkg-b/node_modules/chai': { version: chaiB, integrity: `sha512-${chaiB}` },
        },
      })
    expect(movedDirs(text('5.0.2', '4.5.0'), text('5.0.3', '4.5.0'))).toEqual(['apps/app-a'])
    // app-a links pkg-b, so pkg-b's own chai is in app-a's reach too.
    expect(movedDirs(text('5.0.2', '4.5.0'), text('5.0.2', '4.5.1'))).toEqual([
      'apps/app-a',
      'packages/pkg-b',
    ])
  })

  // Item 1073's class, npm's side: two workspaces that link each other,
  // each on its own is-number. Swapping which one reaches 7.0.0 gives
  // their nodes the same lines unless each folds its own path — both are
  // version 1.0.0 with no resolved or integrity — and neither moved.
  it('two workspaces that link each other and swap versions both move', () => {
    const swap = (aNested: boolean) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { workspaces: ['packages/*'] },
          'packages/a': { version: '1.0.0', dependencies: { b: '*', 'is-number': '*' } },
          'packages/b': { version: '1.0.0', dependencies: { a: '*', 'is-number': '*' } },
          'node_modules/a': { resolved: 'packages/a', link: true },
          'node_modules/b': { resolved: 'packages/b', link: true },
          'node_modules/is-number': { version: '6.0.0', resolved: 'r6', integrity: 'i6' },
          [`packages/${aNested ? 'a' : 'b'}/node_modules/is-number`]: {
            version: '7.0.0',
            resolved: 'r7',
            integrity: 'i7',
          },
        },
      })
    const one = importerDigests(parseLockfile(swap(true)))
    const two = importerDigests(parseLockfile(swap(false)))
    const again = importerDigests(parseLockfile(swap(true)))
    expect({
      a: one.get('packages/a') !== two.get('packages/a'),
      b: one.get('packages/b') !== two.get('packages/b'),
      control: one.get('packages/a') === again.get('packages/a'),
    }).toEqual({ a: true, b: true, control: true })
  })
})

describe('npm() declared', () => {
  let root: string
  const BUILD =
    "export default { tasks: { build: { exec: { command: 'echo built' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }\n"
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-npm-'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
    )
    for (const name of ['a', 'b', 'c']) {
      const dir = path.join(root, 'packages', name)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
      await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
    }
    await writeFile(path.join(root, 'package-lock.json'), lock())
    await Bun.write(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource(['npm()'], `import { npm } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a hoisted bump re-keys only the projects that reach it', async () => {
    const hashes = async () => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
    }
    const before = await hashes()
    await writeFile(path.join(root, 'package-lock.json'), lock({ bar: '2.0.1' }))
    const after = await hashes()
    expect(after['a#build']).not.toBe(before['a#build'])
    expect(after['b#build']).toBe(before['b#build'])
    expect(after['c#build']).toBe(before['c#build'])
  })

  it('a root devDependency bump re-keys and selects every project: the root `.bin` is on every PATH', async () => {
    // The root package's tools run from the root `node_modules/.bin`,
    // which core puts on every task's PATH, and Node resolution walks up
    // to the root `node_modules`: a bump that moved no project's key
    // replayed the old tool's output (nx#36415 class, 2026-09-24).
    const plan = async () => {
      const p = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      return Object.fromEntries(p.tasks.map((t) => [t.node.id, t.hash]))
    }
    commitAll(root)
    const before = await plan()
    // CONTROL: a package only `a` reaches still moves only a's key.
    await writeFile(path.join(root, 'package-lock.json'), lock({ bar: '2.0.1' }))
    expect(moved(before, await plan())).toEqual(['a#build'])
    expect(affectedIds(root, 'build')).toEqual(['a#build'])
    await writeFile(path.join(root, 'package-lock.json'), lock({ ts: '5.1.0' }))
    expect(moved(before, await plan())).toEqual(['a#build', 'b#build', 'c#build'])
    expect(affectedIds(root, 'build')).toEqual(['a#build', 'b#build', 'c#build'])
  })

  it('refuses an unknown scope', () => {
    expect(() => npm({ scope: 'x' as never })).toThrow(
      /npm\(\) option "scope" must be 'project' or 'workspace', got/,
    )
  })
})
