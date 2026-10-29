// The hashing and input scenarios Nx and Turbo test that vx passed with no
// test of its own (Growth's hash-tests map, org/growth/parity/hash-tests,
// rows T6-T27). Each is a key read twice: a change the scenario says is
// an input must move it, one it says is not must leave it.

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { resolveInputs } from '../src/cache/inputs.js'
import type { InputsConfig } from '../src/config.js'
import { relPosix } from '../src/util/index.js'
import { validateProjectConfig } from '../src/workspace/config-schema.js'
import { dry, PARITY_TIMEOUT as TIMEOUT } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

const task = (inputs: string) =>
  `{ exec: { command: 'true' }, inputs: ${inputs}, cache: { outputs: { files: [] } } }`

/** A workspace with project `lib` (tasks `t`, …) and `files` beside it, committed. */
async function workspace(
  inputs: string,
  files: Record<string, string>,
  root: Record<string, string> = {},
  opts: { dir?: string; edges?: Record<string, string[]> } = {},
): Promise<string> {
  const ws = await makeWorkspace({ prefix: 'vx-hash-scen-', ...opts })
  made.push(ws)
  await addProject(ws, 'lib', {
    config: `export default { tasks: { t: ${task(inputs)} } }\n`,
    files,
  })
  for (const [rel, body] of Object.entries({ '.gitignore': '.vx/cache/\n', ...root })) {
    await mkdir(path.dirname(path.join(ws, rel)), { recursive: true })
    await writeFile(path.join(ws, rel), body)
  }
  const git = gitIn(ws)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return ws
}

async function key(root: string, env: Record<string, string> = {}): Promise<string> {
  const t = (await dry(root, ['lib#t'], env)).find((x) => x.id === 'lib#t')
  if (t === undefined) throw new Error('lib#t not planned')
  return t.hash
}

const at = (root: string, rel: string) => path.join(root, 'packages', 'lib', rel)

describe('line endings (Turbo crlf)', () => {
  for (const attr of ['* text=auto\n', '* text\n', '*.txt text eol=crlf\n']) {
    it(
      `${attr.trim()}: a touch keeps the key, a same-size edit moves it, restoring the bytes brings it back`,
      async () => {
        const root = await workspace(
          "{ files: ['a.txt'] }",
          { 'a.txt': 'one\r\ntwo\r\n' },
          {
            '.gitattributes': attr,
          },
        )
        const clean = await key(root)
        const later = new Date(Date.now() + 5_000)
        await utimes(at(root, 'a.txt'), later, later)
        expect(await key(root)).toBe(clean)
        await writeFile(at(root, 'a.txt'), 'onE\r\ntwo\r\n')
        expect(await key(root)).not.toBe(clean)
        await writeFile(at(root, 'a.txt'), 'one\r\ntwo\r\n')
        expect(await key(root)).toBe(clean)
      },
      TIMEOUT,
    )
  }

  it(
    "a project's own .gitattributes applies: a same-size edit to a `text` file moves the key",
    async () => {
      const root = await workspace("{ files: ['a.md'] }", {
        '.gitattributes': '*.md text\n',
        'a.md': 'one\r\ntwo\r\n',
      })
      const clean = await key(root)
      await writeFile(at(root, 'a.md'), 'onE\r\ntwo\r\n')
      expect(await key(root)).not.toBe(clean)
    },
    TIMEOUT,
  )
})

/**
 * Back-date `rels` and refresh the index, so git records their stat with no
 * racy smudge: a file written in the second of its commit is hashed from
 * disk whatever git says, which would hide a wrong clean verdict.
 */
async function settle(root: string, rels: readonly string[]): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  for (const rel of rels) await utimes(at(root, rel), past, past)
  gitIn(root)('update-index', '--really-refresh')
}

// Turbo d154e7e92 (vercel/turborepo#14697) matched git's text=auto binary
// check: a file git stores raw keeps its CRs. vx hashes a filtered file's
// raw bytes, so a LF→CRLF rewrite moves the key whatever git thinks of it.
describe('text=auto, git binary detection (vercel/turborepo#14697)', () => {
  it.each([
    ['a lone CR', 'a\nb\rc\n'],
    ['a NUL past the first 8000 bytes', `${'a\n'.repeat(4500)}\0\n`],
    ['a control byte', 'a\u0001\nb\n'],
    ['plain text', 'a\nb\n'],
  ])(
    '%s: an LF→CRLF rewrite moves the key',
    async (_, body) => {
      const root = await workspace(
        "{ files: ['data.bin'] }",
        { 'data.bin': body },
        {
          '.gitattributes': '* text=auto\n',
        },
      )
      await settle(root, ['data.bin'])
      const clean = await key(root)
      await writeFile(at(root, 'data.bin'), body.replaceAll('\n', '\r\n'))
      expect(await key(root)).not.toBe(clean)
      // CONTROL: the bytes back, the key back.
      await writeFile(at(root, 'data.bin'), body)
      expect(await key(root)).toBe(clean)
    },
    TIMEOUT,
  )
})

// Turbo ebc204865 (vercel/turborepo#10844): without `-z` git C-quotes a
// non-ASCII path, which then names no file.
describe('a non-ASCII tracked input (vercel/turborepo#10844)', () => {
  it(
    'an uncommitted edit to it moves the key; the bytes back bring it back',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", { 'src/테스트.ts': 'one\n' })
      await settle(root, ['src/테스트.ts'])
      const clean = await key(root)
      await writeFile(at(root, 'src/테스트.ts'), 'two\n')
      expect(await key(root)).not.toBe(clean)
      await writeFile(at(root, 'src/테스트.ts'), 'one\n')
      expect(await key(root)).toBe(clean)
    },
    TIMEOUT,
  )
})

describe('ignore rules (Turbo scm, Nx walker)', () => {
  it(
    'an uncommitted .gitignore edit that un-ignores a file makes it an input, and one that re-ignores it takes it out',
    async () => {
      const root = await workspace(
        "{ files: ['src/**'] }",
        { 'src/a.txt': 'a\n' },
        { '.gitignore': '.vx/cache/\npackages/lib/src/gen.txt\n' },
      )
      await writeFile(at(root, 'src/gen.txt'), 'g\n')
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\n')
      const open = await key(root)
      await writeFile(at(root, 'src/gen.txt'), 'g2\n')
      expect(await key(root)).not.toBe(open)
      await writeFile(path.join(root, '.gitignore'), '.vx/cache/\npackages/lib/src/gen.txt\n')
      const closed = await key(root)
      await writeFile(at(root, 'src/gen.txt'), 'g3\n')
      expect(await key(root)).toBe(closed)
    },
    TIMEOUT,
  )

  it(
    'a self-ignoring `*` .gitignore keeps what it whitelists and nothing else',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", {
        'src/a.txt': 'a\n',
        'src/cache/.gitignore': '*\n!keep.txt\n!.gitignore\n',
      })
      await writeFile(at(root, 'src/cache/keep.txt'), 'k\n')
      await writeFile(at(root, 'src/cache/junk.txt'), 'j\n')
      const k0 = await key(root)
      await writeFile(at(root, 'src/cache/junk.txt'), 'j2\n')
      expect(await key(root)).toBe(k0)
      await writeFile(at(root, 'src/cache/keep.txt'), 'k2\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'only a file named .gitignore holds rules: foo.gitignore and .ignore do not',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", {
        'src/a.txt': 'a\n',
        'src/foo.gitignore': '*\n',
        'src/.ignore': 'b.txt\n',
        '.ignore': '*\n',
      })
      await writeFile(at(root, 'src/b.txt'), 'b\n')
      const k0 = await key(root)
      await writeFile(at(root, 'src/b.txt'), 'b2\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'a .gitignore above the git root does not apply',
    async () => {
      const outer = await mkdtemp(path.join(os.tmpdir(), 'vx-hash-scen-outer-'))
      made.push(outer)
      await writeFile(path.join(outer, '.gitignore'), '*.txt\n')
      const root = await workspace(
        "{ files: ['src/**'] }",
        { 'src/a.txt': 'a\n' },
        {},
        { dir: outer },
      )
      const k0 = await key(root)
      await writeFile(at(root, 'src/b.txt'), 'b\n')
      expect(await key(root)).not.toBe(k0)
    },
    TIMEOUT,
  )
})

describe('the walk (Turbo globwalk, Nx walker)', () => {
  it.skipIf(process.platform === 'win32')(
    // A socket too, in Turbo's test; the shard's sandbox refuses the bind.
    'a FIFO under an input glob neither hangs the key nor moves it',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", { 'src/a.txt': 'a\n' })
      const k0 = await key(root)
      expect(Bun.spawnSync(['mkfifo', at(root, 'src/fifo')]).exitCode).toBe(0)
      expect(await key(root)).toBe(k0)
    },
    TIMEOUT,
  )

  it(
    'files created and deleted while the key is read never fail it',
    async () => {
      const root = await workspace("{ files: ['src/**'] }", { 'src/a.txt': 'a\n' })
      let stop = false
      const churn = (async () => {
        for (let i = 0; !stop; i++) {
          for (let k = 0; k < 50; k++) {
            const p = at(root, `src/v${k}.txt`)
            await writeFile(p, String(i)).catch(() => undefined)
            await rm(p, { force: true })
          }
        }
      })()
      try {
        for (let i = 0; i < 8; i++) expect(await key(root)).toMatch(/^[0-9a-f]+$/)
      } finally {
        stop = true
        await churn
      }
    },
    TIMEOUT,
  )
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
        config: `export default { tasks: { t: { exec: { command: 'true' }, dependsOn: ['^t'], inputs: { files: ['src/**'], workspaceFiles: ['README.md'] }, cache: { outputs: { files: [] } } } } }\n`,
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

describe('refused at vx lock (Turbo, Nx)', () => {
  const refusal = (inputs: InputsConfig): string => {
    try {
      validateProjectConfig(
        { tasks: { t: { exec: { command: 'x' }, inputs, cache: { outputs: { files: [] } } } } },
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
})
