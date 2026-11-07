// The hashing and input scenarios Nx and Turbo test that vx passed with no
// test of its own, as hash-scenarios.test.ts: env names, selection, names
// taken literally or read by a shell, the workspace config, what vx lock
// refuses and untracked inputs.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { resolveInputs } from '../src/cache/inputs.js'
import type { InputsConfig } from '../src/config.js'
import { relPosix } from '../src/util/index.js'
import { validateProjectConfig } from '../src/workspace/config-schema.js'
import { at, key, made, task, workspace } from './helpers/hash-scenarios.js'
import { dry, PARITY_TIMEOUT as TIMEOUT } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('env names (Turbo env)', () => {
  for (const name of ['ProgramFiles(x86)', 'é東京', 'A\nB']) {
    it(
      `${JSON.stringify(name)}: its value moves the key, a look-alike name does not`,
      async () => {
        const root = await workspace(`{ files: [], env: [${JSON.stringify(name)}] }`, {})
        const one = await key(root, { [name]: '1' })
        expect(await key(root, { [name]: '1' })).toBe(one)
        expect(await key(root, { [name]: '2' })).not.toBe(one)
        expect(await key(root, { [name]: '1', [`${name}X`]: '2' })).toBe(one)
      },
      TIMEOUT,
    )
  }
})

describe('selection (Turbo task-hash)', () => {
  it(
    'a dependency without the task carries no root file in; a workspace input still moves the key',
    async () => {
      const ws = await makeWorkspace({ prefix: 'vx-hash-scen-', edges: { lib: ['dep'] } })
      made.push(ws)
      await addProject(ws, 'lib', {
        config: `export default { tasks: { t: { exec: { command: 'true' }, dependsOn: ['^t'], inputs: { files: ['src/**'], workspaceFiles: ['README.md'] }, outputs: { files: [] }, cache: true } } }\n`,
        files: { 'src/a': 'a\n' },
      })
      await addProject(ws, 'dep', { config: 'export default { tasks: {} }\n' })
      await writeFile(path.join(ws, 'README.md'), 'r\n')
      await writeFile(path.join(ws, 'LICENSE'), 'l\n')
      await writeFile(path.join(ws, '.gitignore'), '.vx/cache/\n')
      const git = gitIn(ws)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      const k0 = await key(ws)
      await writeFile(path.join(ws, 'LICENSE'), 'l2\n')
      expect(await key(ws)).toBe(k0)
      await writeFile(path.join(ws, 'README.md'), 'r2\n')
      expect(await key(ws)).not.toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'the key is the same under --affected, a negated filter, a task id and --all, with an untracked file',
    async () => {
      const ws = await makeWorkspace({ prefix: 'vx-hash-scen-' })
      made.push(ws)
      for (const p of ['lib', 'other'])
        await addProject(ws, p, {
          config: `export default { tasks: { t: ${task("{ files: ['src/**'] }")} } }\n`,
          files: { 'src/a': `${p}\n` },
        })
      await writeFile(path.join(ws, '.gitignore'), '.vx/cache/\n')
      const git = gitIn(ws)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      await writeFile(path.join(ws, 'packages/lib/src/new.txt'), 'n\n')
      const of = async (args: string[]) => (await dry(ws, args)).find((t) => t.id === 'lib#t')?.hash
      const all = await of(['t', '--all'])
      expect(all).toBeDefined()
      expect(await of(['t', '--affected=HEAD'])).toBe(all)
      expect(await of(['t', '--filter', '!other'])).toBe(all)
      expect(await of(['lib#t'])).toBe(all)
    },
    TIMEOUT,
  )
})

describe('names taken literally (Turbo, Nx disk expansion)', () => {
  const tree = [
    'src/foo:bar.txt',
    'src/foo::bar.txt',
    'src/a,b.ts',
    'src/ab.ts',
    'src/@scope/pkg/x.js',
    'src/a+b/y.txt',
    'app/(marketing)/page.js',
    'app/[id]/page.js',
    'other.js',
  ]
  let root = ''
  async function resolve(files: string[]): Promise<string[]> {
    if (root === '') {
      root = await mkdtemp(path.join(os.tmpdir(), 'vx-hash-scen-names-'))
      for (const rel of tree) {
        await mkdir(path.dirname(path.join(root, 'p', rel)), { recursive: true })
        await writeFile(path.join(root, 'p', rel), rel)
      }
      gitIn(root)('init', '-q')
      gitIn(root)('add', '-A')
    }
    const r = await resolveInputs({
      projectDir: path.join(root, 'p'),
      workspaceRoot: root,
      envSource: {},
      inputs: { files } as InputsConfig,
      ownOutputs: [],
      nestedProjectDirs: [],
    })
    return r.files.map((f) => relPosix(path.join(root, 'p'), f)).sort()
  }
  afterEach(() => {
    if (root !== '') made.push(root)
    root = ''
  })

  it('`:` and `,` are name characters', async () => {
    expect(await resolve(['src/*:bar.txt'])).toEqual(['src/foo::bar.txt', 'src/foo:bar.txt'])
    expect(await resolve(['src/a,b.ts'])).toEqual(['src/a,b.ts'])
  })

  it('`@scope`, `a+b`, `(group)` and an escaped `\\[id\\]` name their directories', async () => {
    expect(await resolve(['src/@scope/pkg/*.js'])).toEqual(['src/@scope/pkg/x.js'])
    expect(await resolve(['src/a+b/**'])).toEqual(['src/a+b/y.txt'])
    expect(await resolve(['app/(marketing)/**'])).toEqual(['app/(marketing)/page.js'])
    expect(await resolve(['app/\\[id\\]/*.js'])).toEqual(['app/[id]/page.js'])
    // Bare, `[id]` is a class: it names `app/i` or `app/d`, never the route.
    expect(await resolve(['app/[id]/*.js'])).toEqual([])
  })
})

describe('names a shell would read (Nx path escaping)', () => {
  it(
    'a $, quotes, a tab and an untracked $ name: each edit moves the key, each revert brings it back',
    async () => {
      const names = ['src/$id.tsx', 'src/sp ace "q" é.ts', 'src/t\tab.ts']
      const root = await workspace(
        "{ files: ['src/**'] }",
        Object.fromEntries(names.map((n) => [n, 'v1'])),
      )
      await writeFile(at(root, 'src/untracked $u.ts'), 'v1')
      const clean = await key(root)
      for (const rel of [...names, 'src/untracked $u.ts']) {
        await writeFile(at(root, rel), 'v2')
        expect({ rel, moved: (await key(root)) !== clean }).toEqual({ rel, moved: true })
        await writeFile(at(root, rel), 'v1')
        expect({ rel, back: (await key(root)) === clean }).toEqual({ rel, back: true })
      }
    },
    TIMEOUT,
  )
})

describe('the workspace config (Nx namedInputs, nx.json)', () => {
  it(
    'an edit to .vx/workspace.mjs that changes no setting moves no task key',
    async () => {
      const root = await workspace("{ files: ['a.txt'] }", { 'a.txt': 'a' })
      const clean = await key(root)
      const file = path.join(root, '.vx', 'workspace.mjs')
      await writeFile(file, `// an unrelated note\n${await Bun.file(file).text()}`)
      expect(await key(root)).toBe(clean)
    },
    TIMEOUT,
  )
})

describe('refused at vx lock (Turbo, Nx)', () => {
  const refusal = (inputs: InputsConfig): string => {
    try {
      validateProjectConfig(
        { tasks: { t: { exec: { command: 'x' }, inputs, outputs: { files: [] }, cache: true } } },
        'vx.config.ts',
      )
    } catch (err) {
      return (err as Error).message
    }
    return 'accepted'
  }

  it.each([
    [
      'an absolute workspace input',
      { files: [], workspaceFiles: ['/etc/hostname'] },
      'absolute paths are not allowed',
    ],
    ['a `..` exclusion', { files: ['**', '!src/../x.txt'] }, "'..' path segments are not allowed"],
    ['a leading-slash input', { files: ['/src/**'] }, 'absolute paths are not allowed'],
    ['`.`, the project itself', { files: ['.'] }, 'names the project directory itself'],
    ['an empty entry', { files: [''] }, 'non-empty strings'],
    ['an empty workspace entry', { files: [], workspaceFiles: [''] }, 'non-empty strings'],
    ['only negations', { files: ['!src/a.txt'] }, 'every entry is a negation'],
    [
      'a literal taken back',
      { files: ['src/a.txt', 'src/b.txt', '!src/a.txt'] },
      'is taken back by',
    ],
  ])('%s', (_, inputs, message) => {
    expect(refusal(inputs)).toContain(message)
  })
})

// vx lists untracked inputs through git (`ls-files --others
// --exclude-standard`), so git's own rules decide what is ignored. Turbo's
// walker reimplemented them and got each of these wrong once.
describe("untracked inputs follow git's ignore rules", () => {
  it(
    "a project's `!` line takes a file back from the root's rule (vercel/turborepo#13221)",
    async () => {
      const root = await workspace(
        "{ files: ['src/**'] }",
        { '.gitignore': '!important.log\n', 'src/a.txt': 'a\n' },
        { '.gitignore': '.vx/cache/\n*.log\n' },
      )
      await writeFile(at(root, 'src/important.log'), 'v1\n')
      await writeFile(at(root, 'src/other.log'), 'v1\n')
      const k0 = await key(root)
      await writeFile(at(root, 'src/other.log'), 'v2\n')
      expect(await key(root)).toBe(k0)
      await writeFile(at(root, 'src/important.log'), 'v2\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'a root pattern two levels into a project applies; its unignored siblings are keyed (vercel/turborepo#13690)',
    async () => {
      const root = await workspace(
        "{ files: ['**'] }",
        { 'src/a.txt': 'a\n' },
        { '.gitignore': '.vx/cache/\npackages/lib/src/deep/*.tmp\n' },
      )
      await mkdir(at(root, 'src/deep'), { recursive: true })
      await writeFile(at(root, 'src/deep/x.tmp'), '1\n')
      const k0 = await key(root)
      await writeFile(at(root, 'src/deep/x.tmp'), '2\n')
      expect(await key(root)).toBe(k0)
      await writeFile(at(root, 'src/deep/y.txt'), '1\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )
})

// vercel/turborepo#13949: a task keyed on workspace files was hashed by a
// shortcut decided before its global inputs were added, and missed their
// change.
it.each([
  ["{ files: [], workspaceFiles: ['g.txt'] }"],
  ["{ files: ['src/**'], workspaceFiles: ['g.txt'] }"],
])(
  '%s re-keys when the workspace file changes',
  async (inputs) => {
    const root = await workspace(
      inputs,
      { 'src/a.txt': 'a\n', 'other.txt': 'o\n' },
      { 'g.txt': '1\n' },
    )
    const k0 = await key(root)
    await writeFile(at(root, 'other.txt'), 'p\n')
    expect(await key(root)).toBe(k0)
    await writeFile(path.join(root, 'g.txt'), '2\n')
    expect(await key(root)).not.toBe(k0)
  },
  TIMEOUT,
)

// vercel/turborepo#13793: an input glob that does not compile (`[invalid`)
// failed affected detection. vx compiles no such class: an unclosed `[` is
// the literal name, keyed as any file is.
it(
  'an unclosed `[` in an input names the literal file, keyed and re-keyed',
  async () => {
    const root = await workspace("{ files: ['src/[invalid'] }", {
      'src/[invalid': 'v1\n',
      'src/i': 'v1\n',
    })
    const k0 = await key(root)
    await writeFile(at(root, 'src/i'), 'v2\n')
    expect(await key(root)).toBe(k0)
    await writeFile(at(root, 'src/[invalid'), 'v2\n')
    expect(await key(root)).not.toBe(k0)
  },
  TIMEOUT,
)
