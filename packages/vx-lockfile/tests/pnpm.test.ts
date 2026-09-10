// Per-importer digests over a pnpm lockfile, and the plugin around them:
// a lockfile change re-keys exactly the projects whose reachable packages
// changed, `--affected` names the same projects, and a warm run reads the
// memo instead of parsing.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pnpm } from '../src/index.js'
import { importerDigests, parseLockfile } from '../src/pnpm.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')

/** A logger that prints nothing: the assertions read the summary, not stdout. */
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
const CORE_BIN = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')

/**
 * A v9 lockfile: `a` → foo → bar; `b` → baz; `c` → link:../b, and qux with
 * two peer resolutions. `bar` is the knob the tests turn.
 */
function v9(
  opts: { bar?: string; baz?: string; patchBar?: boolean; pnpmfile?: string } = {},
): string {
  const bar = opts.bar ?? '2.0.0'
  const baz = opts.baz ?? '3.0.0'
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
${opts.pnpmfile === undefined ? '' : `pnpmfileChecksum: ${opts.pnpmfile}\n`}${
    opts.patchBar === true
      ? `patchedDependencies:
  bar:
    hash: abc123
    path: patches/bar.patch
`
      : ''
  }
importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5
        version: 5.0.0

  packages/a:
    dependencies:
      foo:
        specifier: ^1
        version: 1.0.0
      qux:
        specifier: ^1
        version: 1.0.0(react@18.0.0)

  packages/b:
    dependencies:
      baz:
        specifier: ^3
        version: ${baz}
      qux:
        specifier: ^1
        version: 1.0.0(react@19.0.0)

  packages/c:
    dependencies:
      b:
        specifier: workspace:*
        version: link:../b

packages:

  bar@${bar}:
    resolution: {integrity: sha512-bar${bar}}

  baz@${baz}:
    resolution: {integrity: sha512-baz${baz}}

  foo@1.0.0:
    resolution: {integrity: sha512-foo}

  qux@1.0.0:
    resolution: {integrity: sha512-qux}
    peerDependencies:
      react: '*'

  react@18.0.0:
    resolution: {integrity: sha512-react18}

  react@19.0.0:
    resolution: {integrity: sha512-react19}

  typescript@5.0.0:
    resolution: {integrity: sha512-ts}

snapshots:

  bar@${bar}: {}

  baz@${baz}: {}

  foo@1.0.0:
    dependencies:
      bar: ${bar}

  qux@1.0.0(react@18.0.0):
    dependencies:
      react: 18.0.0

  qux@1.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0

  react@18.0.0: {}

  react@19.0.0: {}

  typescript@5.0.0: {}
`
}

/** The same graph as `v9`, in the v6 shape (deps live on `packages`, keys are `/name@version`). */
function v6(bar = '2.0.0'): string {
  return `lockfileVersion: '6.0'

importers:

  packages/a:
    dependencies:
      foo:
        specifier: ^1
        version: 1.0.0

  packages/b:
    dependencies:
      baz:
        specifier: ^3
        version: 3.0.0

packages:

  /bar@${bar}:
    resolution: {integrity: sha512-bar${bar}}
    dev: false

  /baz@3.0.0:
    resolution: {integrity: sha512-baz}
    dev: false

  /foo@1.0.0:
    resolution: {integrity: sha512-foo}
    dependencies:
      bar: ${bar}
    dev: false
`
}

const digests = (text: string) => importerDigests(parseLockfile(text))

describe('importer digests', () => {
  it('a transitive bump moves the importers that reach it and no other', () => {
    const before = digests(v9())
    const after = digests(v9({ bar: '2.0.1' }))
    expect([...before.keys()]).toEqual(['.', 'packages/a', 'packages/b', 'packages/c'])
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    expect(after.get('packages/b')).toBe(before.get('packages/b'))
    expect(after.get('packages/c')).toBe(before.get('packages/c'))
    expect(after.get('.')).toBe(before.get('.'))
  })

  it("a `link:` dependency folds the linked importer's closure", () => {
    const before = digests(v9())
    const after = digests(v9({ baz: '3.0.1' }))
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    expect(after.get('packages/c')).not.toBe(before.get('packages/c'))
    expect(after.get('packages/a')).toBe(before.get('packages/a'))
  })

  it('two importers on different peer resolutions of one package differ', () => {
    // `qux@1.0.0(react@18)` and `(react@19)` are different node_modules.
    const d = digests(v9())
    expect(d.get('packages/a')).not.toBe(d.get('packages/b'))
    const swapped = v9().replace('version: 1.0.0(react@18.0.0)', 'version: 1.0.0(react@19.0.0)')
    expect(digests(swapped).get('packages/a')).not.toBe(d.get('packages/a'))
  })

  it('a patch moves only the importers that reach the patched package', () => {
    const before = digests(v9())
    const after = digests(v9({ patchBar: true }))
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    expect(after.get('packages/b')).toBe(before.get('packages/b'))
  })

  it('an install-wide knob (pnpmfile, settings) moves every importer', () => {
    const before = digests(v9())
    const after = digests(v9({ pnpmfile: 'deadbeef' }))
    for (const dir of before.keys()) expect(after.get(dir)).not.toBe(before.get(dir))
  })

  it('is independent of YAML key order', () => {
    const text = v9()
    const reordered = text.replace(
      /\n  packages\/a:[\s\S]*?\n\n  packages\/b:([\s\S]*?)\n\n  packages\/c:/,
      (m) => {
        const a = m.slice(0, m.indexOf('\n\n  packages/b:'))
        const b = m.slice(m.indexOf('\n\n  packages/b:') + 2, m.indexOf('\n\n  packages/c:'))
        return `\n${b}\n${a}\n\n  packages/c:`
      },
    )
    expect(reordered).not.toBe(text)
    expect(digests(reordered)).toEqual(digests(text))
  })

  it('reads the v6 shape (dependencies on `packages`, `/name@version` keys)', () => {
    const before = digests(v6())
    const after = digests(v6('2.0.1'))
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    expect(after.get('packages/b')).toBe(before.get('packages/b'))
  })

  it('follows an alias to its own snapshot', () => {
    const lock = (dep: string) => `lockfileVersion: '9.0'
importers:
  packages/a:
    dependencies:
      sw-cjs:
        specifier: npm:string-width@^4
        version: string-width@4.2.3
packages:
  string-width@4.2.3:
    resolution: {integrity: sha512-sw}
  ${dep}:
    resolution: {integrity: sha512-dep}
snapshots:
  string-width@4.2.3:
    dependencies:
      emoji-regex: ${dep.split('@')[1]}
  ${dep}: {}
`
    expect(digests(lock('emoji-regex@8.0.0')).get('packages/a')).not.toBe(
      digests(lock('emoji-regex@8.0.1')).get('packages/a'),
    )
  })

  it('a dependency cycle terminates, and a change inside it moves what reaches it', () => {
    // pnpm writes cycles (peer loops, a↔b). The component is the unit:
    // both members fold together, and only importers that reach the cycle
    // move when one member's resolution changes.
    const lock = (int: string) => `lockfileVersion: '9.0'
importers:
  packages/a:
    dependencies:
      x:
        specifier: ^1
        version: 1.0.0
  packages/b:
    dependencies:
      z:
        specifier: ^1
        version: 1.0.0
packages:
  x@1.0.0:
    resolution: {integrity: sha512-x}
  y@1.0.0:
    resolution: {integrity: ${int}}
  z@1.0.0:
    resolution: {integrity: sha512-z}
snapshots:
  x@1.0.0:
    dependencies:
      y: 1.0.0
  y@1.0.0:
    dependencies:
      x: 1.0.0
  z@1.0.0: {}
`
    const before = digests(lock('sha512-y'))
    const after = digests(lock('sha512-y2'))
    expect(after.get('packages/a')).not.toBe(before.get('packages/a'))
    expect(after.get('packages/b')).toBe(before.get('packages/b'))
    expect(digests(lock('sha512-y'))).toEqual(before)
  })

  it('refuses what is not a pnpm lockfile', () => {
    expect(() => parseLockfile('just: yaml\n')).toThrow(/unsupported lockfileVersion ""/)
    expect(() => parseLockfile('- a\n')).toThrow(/not a YAML document/)
  })
})

describe('pnpm()', () => {
  it('refuses an unknown scope', () => {
    expect(() => pnpm({ scope: 'file' as never })).toThrow(
      /pnpm\(\) scope must be 'project' or 'workspace'/,
    )
  })

  describe('affected', () => {
    const ctx = (root: string) => ({
      workspaceRoot: root,
      cacheDir: path.join(root, '.vx', 'cache'),
      warn: () => {},
      projects: [
        { name: 'a', dir: path.join(root, 'packages/a') },
        { name: 'b', dir: path.join(root, 'packages/b') },
        { name: 'c', dir: path.join(root, 'packages/c') },
        // Not an importer: resolves from the root's node_modules only.
        { name: 'tools', dir: path.join(root, 'tools') },
      ],
    })
    const bytes = (s: string) => new TextEncoder().encode(s)
    const affected = (plugin = pnpm(), before: string | null, after: string | null) =>
      plugin.fingerprint!.affected(
        {
          file: 'pnpm-lock.yaml',
          before: before === null ? null : bytes(before),
          after: after === null ? null : bytes(after),
        },
        ctx('/ws'),
      )

    it('names the projects whose digest moved, following links', async () => {
      expect([...(await affected(pnpm(), v9(), v9({ bar: '2.0.1' })))!]).toEqual(['a'])
      expect([...(await affected(pnpm(), v9(), v9({ baz: '3.0.1' })))!]).toEqual(['b', 'c'])
      expect([...(await affected(pnpm(), v9(), v9()))!]).toEqual([])
    })

    it('a project outside the lockfile follows the root importer', async () => {
      const rootBump = v9()
        .replace('version: 5.0.0', 'version: 5.1.0')
        .replace(/typescript@5\.0\.0/g, 'typescript@5.1.0')
      expect([...(await affected(pnpm(), v9(), rootBump))!]).toEqual(['tools'])
    })

    it('cannot tell when the file appeared or went, or under scope: workspace', async () => {
      expect(await affected(pnpm(), null, v9())).toBeUndefined()
      expect(await affected(pnpm(), v9(), null)).toBeUndefined()
      expect(
        await affected(pnpm({ scope: 'workspace' }), v9(), v9({ bar: '2.0.1' })),
      ).toBeUndefined()
    })
  })
})

describe('vx run with pnpm() declared', () => {
  let root: string
  const BUILD =
    "export default { tasks: { build: { exec: { command: 'echo built' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n"

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-pnpm-'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', private: true }),
    )
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    for (const name of ['a', 'b', 'c']) {
      const dir = path.join(root, 'packages', name)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
      await writeFile(path.join(dir, 'src', 'index.js'), `// ${name}\n`)
      await writeFile(path.join(dir, 'vx.config.mjs'), BUILD)
    }
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9())
    await workspace('pnpm()')
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function workspace(...plugins: string[]): Promise<void> {
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource(plugins, `import { pnpm } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
    )
  }
  const hashes = async (): Promise<Record<string, string>> => {
    const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
    return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.hash]))
  }
  const statuses = async (): Promise<Record<string, string>> => {
    const r = await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
    expect(r.ok).toBe(true)
    return Object.fromEntries(r.outcomes.map((o) => [o.node.id, o.status]))
  }

  it('a dependency bump re-keys only the projects that reach it', async () => {
    const before = await hashes()
    expect(await statuses()).toEqual({
      'a#build': 'success',
      'b#build': 'success',
      'c#build': 'success',
    })
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9({ bar: '2.0.1' }))
    const after = await hashes()
    expect(after['a#build']).not.toBe(before['a#build'])
    expect(after['b#build']).toBe(before['b#build'])
    expect(after['c#build']).toBe(before['c#build'])
    expect(await statuses()).toEqual({
      'a#build': 'success',
      'b#build': 'cache-hit',
      'c#build': 'cache-hit',
    })
    // CONTROL: with no plugin the same edit re-keys every task.
    await workspace()
    const bare = await hashes()
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9({ bar: '2.0.2' }))
    const bareAfter = await hashes()
    for (const id of Object.keys(bare)) expect(bareAfter[id]).not.toBe(bare[id])
  })

  it('a bump behind a `link:` re-keys the linking project too', async () => {
    const before = await hashes()
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9({ baz: '3.0.1' }))
    const after = await hashes()
    expect(after['a#build']).toBe(before['a#build'])
    expect(after['b#build']).not.toBe(before['b#build'])
    expect(after['c#build']).not.toBe(before['c#build'])
  })

  it('`vx why` names the plugin part; the workspace fingerprint no longer moves', async () => {
    await statuses()
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9({ bar: '2.0.1' }))
    await statuses()
    const why = Bun.spawnSync({
      cmd: [process.execPath, CORE_BIN, 'why', 'a#build'],
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
    })
    const out = new TextDecoder().decode(why.stdout)
    expect(why.exitCode).toBe(0)
    expect(out).toMatch(/changed +plugin +@vzn\/vx-lockfile\/pnpm/)
    expect(out).not.toMatch(/changed +workspace +fingerprint/)
  })

  it('`--affected` selects the projects the bump reaches', async () => {
    const git = (...args: string[]) =>
      Bun.spawnSync({
        cmd: [
          'git',
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.email=t@vx',
          '-c',
          'user.name=t',
          ...args,
        ],
        cwd: root,
      })
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9({ baz: '3.0.1' }))
    const r = Bun.spawnSync({
      cmd: [process.execPath, CORE_BIN, 'run', 'build', '--affected=HEAD'],
      cwd: root,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr)
    expect(r.exitCode).toBe(0)
    expect(out).toContain('2 affected · 3 total')
    expect(out).toContain('b#build')
    expect(out).toContain('c#build')
    expect(out).not.toContain('a#build')
  })

  it('scope: workspace folds the whole file into every task', async () => {
    await workspace("pnpm({ scope: 'workspace' })")
    const before = await hashes()
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9({ bar: '2.0.1' }))
    const after = await hashes()
    for (const id of Object.keys(before)) expect(after[id]).not.toBe(before[id])
  })

  it('no lockfile: nothing is folded', async () => {
    const before = await hashes()
    await rm(path.join(root, 'pnpm-lock.yaml'))
    const without = await hashes()
    expect(without).not.toEqual(before)
    // Absent stays absent: the same hashes on the next derivation, and
    // no memo is written for a file that is not there.
    expect(await hashes()).toEqual(without)
  })

  it('a warm run reads the memo instead of parsing', async () => {
    await hashes()
    const memoFile = path.join(root, '.vx', 'cache', 'lockfile-claims', 'pnpm-lock.yaml.json')
    const memo = JSON.parse(await readFile(memoFile, 'utf8')) as {
      version: number
      lock: string
      importers: Record<string, string>
    }
    expect(Object.keys(memo.importers).sort()).toEqual([
      '.',
      'packages/a',
      'packages/b',
      'packages/c',
    ])
    // Plant a sentinel digest under the same lock hash: a fresh plugin
    // instance (a workspace file whose bytes differ evaluates anew; the
    // same bytes would serve the module, and its memory, again) must key
    // on it — the proof the memo was read and the file not parsed.
    const before = await hashes()
    memo.importers['packages/a'] = 'sentinel'
    await writeFile(memoFile, JSON.stringify(memo))
    await workspace('pnpm() /* fresh instance */')
    const planted = await hashes()
    expect(planted['a#build']).not.toBe(before['a#build'])
    expect(planted['b#build']).toBe(before['b#build'])
    // A lockfile whose bytes changed ignores the stale memo.
    await writeFile(path.join(root, 'pnpm-lock.yaml'), v9({ pnpmfile: 'x' }))
    await workspace('pnpm() /* another */')
    const fresh = JSON.parse(await readFile(memoFile, 'utf8')) as { lock: string }
    await hashes()
    const rewritten = JSON.parse(await readFile(memoFile, 'utf8')) as { lock: string }
    expect(rewritten.lock).not.toBe(fresh.lock)
  })
})
