// package-lock.json (v2/v3): per-workspace digests through npm's nested
// node_modules layout and workspace links, and the plugin end to end.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, type Logger } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { npm } from '../src/index.js'
import { importerDigests, parseLockfile } from '../src/npm.js'

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
  opts: { bar?: string; baz?: string; nestedBar?: string; overrides?: string } = {},
): string {
  const bar = opts.bar ?? '2.0.0'
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
          version: '5.0.0',
          resolved: 'https://r/ts.tgz',
          integrity: 'sha512-ts',
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

  it('root overrides move every workspace', () => {
    const before = digests(lock())
    const after = digests(lock({ overrides: '4.0.0' }))
    for (const dir of before.keys()) expect(after.get(dir)).not.toBe(before.get(dir))
  })

  it('refuses what is not an npm v2+ lockfile', () => {
    expect(() => parseLockfile('{"name":"x"}')).toThrow(/no lockfileVersion/)
    expect(() => parseLockfile('{"lockfileVersion":1,"dependencies":{}}')).toThrow(
      /lockfileVersion 1 has no/,
    )
    expect(() => parseLockfile('nope')).toThrow(/package-lock.json:/)
  })
})

describe('npm() declared', () => {
  let root: string
  const BUILD =
    "export default { tasks: { build: { exec: { command: 'echo built' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n"
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
    await writeFile(
      path.join(root, 'vx.workspace.mjs'),
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

  it('refuses an unknown scope', () => {
    expect(() => npm({ scope: 'x' as never })).toThrow(
      /npm\(\) scope must be 'project' or 'workspace'/,
    )
  })
})
