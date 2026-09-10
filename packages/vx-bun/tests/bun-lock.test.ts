// Per-workspace digests over a bun.lock, and the plugin around them: a
// lockfile change re-keys exactly the projects whose reachable packages
// changed (through Bun's hoisted layout), and `--affected` names them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { bun, importerDigests, parseLockfile } from '../src/index.js'

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
  opts: { bar?: string; baz?: string; nestedBar?: string; override?: string } = {},
): string {
  const bar = opts.bar ?? '2.0.0'
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
    "typescript": ["typescript@5.0.0", "", { "bin": "bin/tsc" }, "sha512-ts"],
  }
}
`
}

const digests = (text: string) => importerDigests(parseLockfile(text))

describe('workspace digests', () => {
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

describe('bun()', () => {
  it('refuses an unknown scope', () => {
    expect(() => bun({ scope: 'file' as never })).toThrow(/scope must be 'project' or 'workspace'/)
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
