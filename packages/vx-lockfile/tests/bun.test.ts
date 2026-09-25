// Per-workspace digests over a bun.lock, and the plugin around them: a
// lockfile change re-keys exactly the projects whose reachable packages
// changed (through Bun's hoisted layout), and `--affected` names them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { affectedIds, commitAll, moved } from './helpers/affected.js'
import { bun } from '../src/index.js'
import { importerDigests, parseLockfile } from '../src/bun.js'
import { lowHalfGlobals } from './helpers/low-half.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const CORE_BIN = path.resolve(import.meta.dir, '..', '..', 'vx', 'src', 'bin.ts')

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
 * A lockfile in Bun's text shape: `a` → foo → bar (hoisted); `b` → baz and
 * its own nested `b/bar` at another version; `c` → the workspace package
 * `b`. `bar` at the root is the knob the tests turn.
 */
function lock(
  opts: { bar?: string; baz?: string; nestedBar?: string; override?: string; ts?: string } = {},
): string {
  const bar = opts.bar ?? '2.0.0'
  const ts = opts.ts ?? '5.0.0'
  const baz = opts.baz ?? '3.0.0'
  const nested = opts.nestedBar ?? '1.0.0'
  return `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "ws",
      "devDependencies": {
        "typescript": "^5",
      },
    },
    "packages/a": {
      "name": "a",
      "dependencies": {
        "foo": "^1",
      },
    },
    "packages/b": {
      "name": "b",
      "dependencies": {
        "baz": "^3",
        "bar": "^1",
      },
    },
    "packages/c": {
      "name": "c",
      "dependencies": {
        "b": "workspace:*",
      },
    },
  },
${opts.override === undefined ? '' : `  "overrides": { "zod": "${opts.override}" },\n`}  "packages": {
    "a": ["a@workspace:packages/a"],
    "b": ["b@workspace:packages/b"],
    "c": ["c@workspace:packages/c"],
    "bar": ["bar@${bar}", "", {}, "sha512-bar${bar}"],
    "b/bar": ["bar@${nested}", "", {}, "sha512-bar${nested}"],
    "baz": ["baz@${baz}", "", {}, "sha512-baz${baz}"],
    "foo": ["foo@1.0.0", "", { "dependencies": { "bar": "^2" } }, "sha512-foo"],
    "typescript": ["typescript@${ts}", "", { "bin": "bin/tsc" }, "sha512-ts${ts}"],
  }
}
`
}

/**
 * A Bun catalog, in the shape a real `bun install` writes: `a` depends
 * on `is-number: catalog:`, the root's `catalog` is copied into the
 * lockfile, and the hoisted `is-number` is what the catalog resolved;
 * `b` → is-odd → is-number ^6 (nested under is-odd once the catalog
 * hoists 7).
 */
function catalogLock(range: string, hoisted: string): string {
  const nested = hoisted.startsWith('6')
    ? ''
    : `
    "is-odd/is-number": ["is-number@6.0.0", "", {}, "sha512-six"],
`
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
    },
    "packages/a": {
      "name": "a",
      "version": "0.0.0",
      "dependencies": {
        "is-number": "catalog:",
      },
    },
    "packages/b": {
      "name": "b",
      "version": "0.0.0",
      "dependencies": {
        "is-odd": "^3.0.1",
      },
    },
  },
  "catalog": {
    "is-number": "${range}",
  },
  "packages": {
    "a": ["a@workspace:packages/a"],

    "b": ["b@workspace:packages/b"],

    "is-number": ["is-number@${hoisted}", "", {}, "sha512-${hoisted}"],

    "is-odd": ["is-odd@3.0.1", "", { "dependencies": { "is-number": "^6.0.0" } }, "sha512-odd"],
${nested}  }
}
`
}

const digests = (text: string) => importerDigests(parseLockfile(text))

describe('workspace digests', () => {
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
    // `b` resolves its own nested `b/bar`, not the root's.
    expect(after.get('packages/b')).toBe(before.get('packages/b'))
    expect(after.get('packages/c')).toBe(before.get('packages/c'))
    expect(after.get('.')).toBe(before.get('.'))
  })

  it('a nested package moves only the workspace it is nested under', () => {
    const before = digests(lock())
    const after = digests(lock({ nestedBar: '1.0.1' }))
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    expect(after.get('packages/a')).toBe(before.get('packages/a'))
  })

  it('a catalog bump moves every workspace: bun.lock records the catalog (turborepo#12635)', () => {
    const moved = (before: string, after: string) => {
      const b = digests(before)
      const a = digests(after)
      return [...a.keys()].filter((k) => a.get(k) !== b.get(k))
    }
    expect(moved(catalogLock('^6.0.0', '6.0.0'), catalogLock('^7.0.0', '7.0.0'))).toEqual([
      '.',
      'packages/a',
      'packages/b',
    ])
    // Inside the range, the catalog unchanged: the hoisted entry moves
    // the workspace that names `catalog:` and no other.
    expect(moved(catalogLock('^7.0.0', '7.0.0'), catalogLock('^7.0.0', '7.0.1'))).toEqual([
      'packages/a',
    ])
  })

  it("a workspace dependency folds the linked workspace's reach", () => {
    const before = digests(lock())
    const after = digests(lock({ baz: '3.0.1' }))
    expect(after.get('packages/b')).not.toBe(before.get('packages/b'))
    expect(after.get('packages/c')).not.toBe(before.get('packages/c'))
    expect(after.get('packages/a')).toBe(before.get('packages/a'))
  })

  it('an install-wide knob (overrides) moves every workspace', () => {
    const before = digests(lock())
    const after = digests(lock({ override: '4.0.0' }))
    for (const dir of before.keys()) expect(after.get(dir)).not.toBe(before.get(dir))
  })

  it('reads a scoped nested path level by level', () => {
    const text = (v: string) => `{
  "lockfileVersion": 1,
  "workspaces": { "": { "name": "ws", "dependencies": { "@s/x": "^1" } } },
  "packages": {
    "@s/x": ["@s/x@1.0.0", "", { "dependencies": { "@s/y": "^1" } }, "sha512-x"],
    "@s/x/@s/y": ["@s/y@${v}", "", {}, "sha512-y${v}"],
    "@s/y": ["@s/y@9.0.0", "", {}, "sha512-y9"],
  }
}
`
    expect(digests(text('1.0.0')).get('.')).not.toBe(digests(text('1.0.1')).get('.'))
  })

  it('refuses what is not a Bun lockfile', () => {
    expect(() => parseLockfile('{"a": 1}')).toThrow(/no lockfileVersion/)
    expect(() => parseLockfile('nope')).toThrow(/bun.lock:/)
  })
})

// What moves a digest, one input at a time. Each row changes exactly the
// thing it names and asserts the workspaces whose key must move: an input
// the digest does not read is a stale hit on every run that changes it.
describe('every input the digest must read', () => {
  const movedDirs = (before: string, after: string): string[] => {
    const b = digests(before)
    const a = digests(after)
    return [...a.keys()].filter((k) => a.get(k) !== b.get(k))
  }
  const doc = (workspaces: string, packages: string, extra = '') => `{
  "lockfileVersion": 1,${extra}
  "workspaces": { ${workspaces} },
  "packages": { ${packages} }
}
`

  it('an optional and a peer dependency are followed like any other', () => {
    for (const field of ['optionalDependencies', 'peerDependencies']) {
      const text = (v: string) =>
        doc(
          `"": { "name": "ws" }, "packages/a": { "name": "a", "${field}": { "opt": "^1" } }`,
          `"a": ["a@workspace:packages/a"], "opt": ["opt@${v}", "", {}, "sha512-${v}"]`,
        )
      expect(movedDirs(text('1.0.0'), text('1.0.1'))).toEqual(['packages/a'])
    }
  })

  it('the integrity alone moves the package, past a non-empty registry field', () => {
    // Same id, same version: a republish or a git dependency's new commit.
    const text = (sha: string) =>
      doc(
        `"": { "name": "ws", "dependencies": { "x": "^1" } }`,
        `"x": ["x@1.0.0", "https://registry.example/", {}, "sha512-${sha}"]`,
      )
    expect(movedDirs(text('one'), text('two'))).toEqual(['.'])
  })

  it.each([
    ['configVersion', '"configVersion": 1,', '"configVersion": 2,'],
    [
      'patchedDependencies',
      '"patchedDependencies": { "x@1.0.0": "p/a.patch" },',
      '"patchedDependencies": { "x@1.0.0": "p/b.patch" },',
    ],
    [
      'catalogs',
      '"catalogs": { "react": { "react": "^18" } },',
      '"catalogs": { "react": { "react": "^19" } },',
    ],
  ])('the install-wide %s moves every workspace', (_, one, two) => {
    const text = (extra: string) =>
      doc(
        `"": { "name": "ws" }, "packages/a": { "name": "a" }`,
        `"a": ["a@workspace:packages/a"]`,
        `\n  ${extra}`,
      )
    expect(movedDirs(text(one), text(two))).toEqual(['.', 'packages/a'])
  })

  it('a dependency resolves at the nearest ancestor that holds it, level by level', () => {
    // x → y (nested under x) → z; `x/z` sits between `x/y/z` (absent) and
    // the root's `z`, and is the one y reaches.
    const text = (v: string) =>
      doc(
        `"": { "name": "ws", "dependencies": { "x": "^1" } }`,
        `"x": ["x@1.0.0", "", { "dependencies": { "y": "^1" } }, "sha512-x"],
    "x/y": ["y@1.0.0", "", { "dependencies": { "z": "^1" } }, "sha512-y"],
    "x/z": ["z@${v}", "", {}, "sha512-z${v}"],
    "z": ["z@9.0.0", "", {}, "sha512-z9"]`,
      )
    expect(movedDirs(text('1.0.0'), text('1.0.1'))).toEqual(['.'])
  })

  it("an unscoped dependency of a scoped package is not the scope's package of that name", () => {
    // From `@s/x`, dependency `y` is `@s/x/y`, else the root's `y` — never
    // `@s/y`, which only shares the scope.
    const text = (v: string) =>
      doc(
        `"": { "name": "ws", "dependencies": { "@s/x": "^1" } }`,
        `"@s/x": ["@s/x@1.0.0", "", { "dependencies": { "y": "^1" } }, "sha512-x"],
    "@s/y": ["@s/y@1.0.0", "", {}, "sha512-sy"],
    "y": ["y@${v}", "", {}, "sha512-y${v}"]`,
      )
    expect(movedDirs(text('1.0.0'), text('1.0.1'))).toEqual(['.'])
  })

  it('an unresolved dependency still folds its specifier, from a workspace and from a package', () => {
    const ws = (spec: string) =>
      doc(`"": { "name": "ws", "dependencies": { "ghost": "${spec}" } }`, ``)
    expect(movedDirs(ws('^1'), ws('^2'))).toEqual(['.'])
    const pkg = (spec: string) =>
      doc(
        `"": { "name": "ws", "dependencies": { "x": "^1" } }`,
        `"x": ["x@1.0.0", "", { "dependencies": { "ghost": "${spec}" } }, "sha512-x"]`,
      )
    expect(movedDirs(pkg('^1'), pkg('^2'))).toEqual(['.'])
  })

  it("a workspace that depends on the root package folds the root's reach", () => {
    const text = (v: string) =>
      doc(
        `"": { "name": "ws", "dependencies": { "t": "^1" } }, "packages/a": { "name": "a", "dependencies": { "ws": "workspace:*" } }`,
        `"ws": ["ws@workspace:"], "a": ["a@workspace:packages/a"], "t": ["t@${v}", "", {}, "sha512-t${v}"]`,
      )
    expect(movedDirs(text('1.0.0'), text('1.0.1'))).toEqual(['.', 'packages/a'])
  })

  it('an entry that is not a package tuple is passed over, not a crash', () => {
    const text = doc(`"": { "name": "ws" }`, `"odd": 5, "also": [7]`)
    expect([...digests(text).keys()]).toEqual(['.'])
  })
})

describe('bun()', () => {
  it('refuses an unknown scope', () => {
    expect(() => bun({ scope: 'file' as never })).toThrow(
      /bun\(\) scope must be 'project' or 'workspace'/,
    )
  })

  it('a lockfile it cannot read names the file ONCE and says what fixes it', () => {
    // The parsers name their own file, and the plugin prefixed it again:
    // "bun.lock: bun.lock: Failed to parse JSONC" reached the user twice
    // over, with no remedy (2026-09-20). Refusing is right — the
    // alternative to reading the lockfile is a WRONG key — so the message
    // is the whole of what the adopter gets.
    expect(bun().fingerprint?.files).toEqual(['bun.lock'])
    let message = ''
    try {
      ;(
        bun() as unknown as { fingerprint: { affected: (c: unknown, x: unknown) => unknown } }
      ).fingerprint.affected(
        {
          file: 'bun.lock',
          before: new TextEncoder().encode('{ not a lockfile'),
          after: new TextEncoder().encode('{ not a lockfile'),
        },
        { workspaceRoot: '/w', cacheDir: '/c', warn() {}, projects: [] },
      )
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('bun.lock: ')
    expect(message.match(/bun\.lock:/g)?.length).toBe(1)
    expect(message).toContain('regenerate it with `bun install`')
  })
})

describe('vx run with bun() declared', () => {
  let root: string
  const BUILD =
    "export default { tasks: { build: { exec: { command: 'echo built' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n"

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-bun-'))
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
    await writeFile(path.join(root, 'bun.lock'), lock())
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
      localWorkspaceSource(['bun()'], `import { bun } from ${JSON.stringify(PLUGIN_INDEX)}\n`),
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

  it('a hoisted bump re-keys only the projects that reach it', async () => {
    const before = await hashes()
    const first = await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
    expect(first.ok).toBe(true)
    await writeFile(path.join(root, 'bun.lock'), lock({ bar: '2.0.1' }))
    const after = await hashes()
    expect(after['a#build']).not.toBe(before['a#build'])
    expect(after['b#build']).toBe(before['b#build'])
    expect(after['c#build']).toBe(before['c#build'])
    const second = await run({ cwd: root, tasks: ['build'], log: silent(), handleSignals: false })
    expect(Object.fromEntries(second.outcomes.map((o) => [o.node.id, o.status]))).toEqual({
      'a#build': 'success',
      'b#build': 'cache-hit',
      'c#build': 'cache-hit',
    })
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
    await writeFile(path.join(root, 'bun.lock'), lock({ bar: '2.0.1' }))
    expect(moved(before, await plan())).toEqual(['a#build'])
    expect(affectedIds(root, 'build')).toEqual(['a#build'])
    await writeFile(path.join(root, 'bun.lock'), lock({ ts: '5.1.0' }))
    expect(moved(before, await plan())).toEqual(['a#build', 'b#build', 'c#build'])
    expect(affectedIds(root, 'build')).toEqual(['a#build', 'b#build', 'c#build'])
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
    await writeFile(path.join(root, 'bun.lock'), lock({ baz: '3.0.1' }))
    const r = Bun.spawnSync({
      cmd: [process.execPath, CORE_BIN, 'run', 'build', '--affected=HEAD'],
      cwd: root,
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
    })
    const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr)
    expect(r.exitCode).toBe(0)
    expect(out).toContain('2 affected · 3 total')
    expect(out).not.toContain('a#build')
  })
})
