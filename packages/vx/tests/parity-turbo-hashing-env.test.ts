// Turbo parity, cache invalidation (no git, env, task hash, line endings;
// scm and file hashing are in parity-turbo-hashing.test.ts): the cases Turbo's own Rust suites pin
// (crates turborepo-scm, turborepo-env, turborepo-task-hash), each ported
// to vx's CLI. A case names the Turbo test it stands in for; a deliberate
// divergence says so in its name. Not ported: symlinked inputs (pinned in
// linked-inputs.test.ts), Vercel's `.env.local` OIDC rotation and Next.js
// env inference (no vx counterpart), and Turbo's internal index, binary
// search and concurrency unit tests (no behaviour a user sees).

import { readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry, PARITY_TIMEOUT as TIMEOUT, summarized, vx } from './helpers/parity.js'

/** One task `t` that reads `inputs` and runs `command`. */
function config(inputs: string, command = 'true', extra = ''): string {
  return `export default {
  tasks: {
    t: {
      exec: { command: ${JSON.stringify(command)} },
      inputs: ${inputs}, cache: { outputs: { files: [] } },
    },
    ${extra}
  },
}
`
}

async function workspace(
  prefix: string,
  projects: Record<string, { config: string; files?: Record<string, string> }>,
  opts: { git?: 'commit' | false; edges?: Record<string, string[]> } = {},
): Promise<string> {
  const root = await makeWorkspace({
    prefix,
    git: opts.git === false ? false : 'init',
    edges: opts.edges ?? {},
  })
  for (const [name, spec] of Object.entries(projects)) await addProject(root, name, spec)
  if (opts.git !== false) {
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  }
  return root
}

async function key(root: string, id: string, env: Record<string, string> = {}): Promise<string> {
  const task = (await dry(root, [id], env)).find((t) => t.id === id)
  if (task === undefined) throw new Error(`${id} not planned`)
  return task.hash
}

describe('Turbo parity — no git (turborepo-scm manual)', () => {
  it(
    '`test_get_package_deps_fallback` — divergence: vx hard-requires git and refuses a tree without one, never walks it',
    async () => {
      const root = await workspace(
        'vx-parity-turbo-nogit-',
        { lib: { config: config("{ files: ['src/**'] }"), files: { 'src/a.txt': 'a\n' } } },
        { git: false },
      )
      try {
        const r = await vx(root, ['run', 'lib#t', '--dry=json'])
        expect(r.code).not.toBe(0)
        expect(r.err).toContain('not inside a git work tree')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '`test_index_equivalence_no_commits_graceful` — a repo with no commit yet keys as its first commit',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-parity-turbo-nocommit-', edges: {} })
      try {
        await addProject(root, 'lib', {
          config: config("{ files: ['src/**'] }"),
          files: { 'src/a.txt': 'a\n' },
        })
        const before = await key(root, 'lib#t')
        const git = gitIn(root)
        git('add', '-A')
        git('commit', '-q', '-m', 'first')
        expect(await key(root, 'lib#t')).toBe(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('Turbo parity — env (turborepo-env)', () => {
  let root: string
  beforeAll(async () => {
    root = await workspace('vx-parity-turbo-env-', {
      lib: {
        config: config("{ files: [], env: ['MODE'] }", 'echo mode=$MODE').replace(
          'command: "echo mode=$MODE" }',
          'command: "echo mode=$MODE", env: { passThrough: [\'MODE\'] } }',
        ),
      },
    })
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`test_case_sensitivity` — `MODE` and `mode` are different variables on POSIX',
    async () => {
      const base = await key(root, 'lib#t', { MODE: 'a' })
      expect(await key(root, 'lib#t', { MODE: 'a', mode: 'b' })).toBe(base)
      expect(await key(root, 'lib#t', { MODE: 'b' })).not.toBe(base)
    },
    TIMEOUT,
  )

  it(
    '`test_hashable_env` — unset and empty key apart; an undeclared variable keys nothing',
    async () => {
      const unset = await key(root, 'lib#t')
      const empty = await key(root, 'lib#t', { MODE: '' })
      expect(empty).not.toBe(unset)
      expect(await key(root, 'lib#t', { MODE: '', OTHER_VAR: 'x' })).toBe(empty)
    },
    TIMEOUT,
  )

  it(
    '`test_pass_through_env_from_parts` ("folds 3 sources": PATH is passed through, not hashed)',
    async () => {
      const base = await key(root, 'lib#t', { MODE: 'a' })
      const p = `${os.tmpdir()}:${process.env['PATH'] ?? ''}`
      expect(await key(root, 'lib#t', { MODE: 'a', PATH: p })).toBe(base)
    },
    TIMEOUT,
  )

  it(
    '`test_wildcard_to_regex_pattern` — divergence: vx refuses an env wildcard (D-53) rather than keying a pattern',
    async () => {
      const own = await workspace('vx-parity-turbo-wild-', {
        lib: { config: config("{ files: [], env: ['FOO*'] }") },
      })
      try {
        const r = await vx(own, ['run', 'lib#t', '--dry=json'])
        expect(r.code).not.toBe(0)
        expect(r.out + r.err).toContain('FOO*')
      } finally {
        await rm(own, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '`test_task_hash_debug_env_vars_exclude_values` — the plan shows no env value',
    async () => {
      const r = await vx(root, ['run', 'lib#t', '--dry=json'], { MODE: 'sekrit-value-123' })
      expect(r.code).toBe(0)
      expect(r.out + r.err).not.toContain('sekrit-value-123')
    },
    TIMEOUT,
  )
})

describe('Turbo parity — task hash and global hash (turborepo-task-hash)', () => {
  let root: string
  beforeAll(async () => {
    const build = (name: string) =>
      `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cat src/in.txt > dist/out.txt && date +%N >> dist/out.txt' },
      dependsOn: ['^build'],
      inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, cache: { outputs: { files: ['dist/**'] } },
    },
    gen: {
      exec: { command: 'mkdir -p gen && cp schema.txt gen/out.txt' },
      inputs: { files: ['schema.txt'] }, cache: { outputs: { files: ['gen/**'] } },
    },
    use: {
      exec: { command: 'cat gen/out.txt' },
      dependsOn: ['gen'],
      inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
    },
    lint: {
      exec: { command: 'echo lint-${name}' },
      inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
    },
  },
}
`
    root = await workspace(
      'vx-parity-turbo-task-',
      {
        lib: { config: build('lib'), files: { 'src/in.txt': 'lib\n', 'schema.txt': 's1\n' } },
        app: { config: build('app'), files: { 'src/in.txt': 'app\n', 'schema.txt': 's1\n' } },
        docs: {
          config: build('docs').replace(", workspaceFiles: ['tsconfig.base.json']", ''),
          files: { 'src/in.txt': 'docs\n', 'schema.txt': 's1\n' },
        },
      },
      { edges: { app: ['lib'] } },
    )
    await writeFile(path.join(root, 'tsconfig.base.json'), '{}\n')
    await writeFile(path.join(root, '.gitignore'), 'dist/\ngen/\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'base')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    "`dependency_output_file_changes_consumer_task_hash` — divergence: vx keys a dependant on its dependency's inputs, not its output bytes",
    async () => {
      // Turbo hashes a dependency's outputs into the consumer when asked;
      // vx folds the upstream INPUT key (principle 5), so a dependency whose
      // output differs run to run (the `date` here) never moves its dependant.
      expect((await summarized(root, ['app#build'])).code).toBe(0)
      const before = await key(root, 'app#build')
      expect((await summarized(root, ['lib#build', '--force'])).code).toBe(0)
      expect(await key(root, 'app#build')).toBe(before)
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'in.txt'), 'lib2\n')
      expect(await key(root, 'app#build')).not.toBe(before)
      await writeFile(path.join(root, 'packages', 'lib', 'src', 'in.txt'), 'lib\n')
    },
    TIMEOUT,
  )

  it(
    '`jit_inputs_are_hashed_after_dependency_files_are_materialized` — a generated input is never replayed stale',
    async () => {
      const lib = path.join(root, 'packages', 'lib')
      const first = await summarized(root, ['lib#use', '--output-logs', 'full'])
      expect(first.code).toBe(0)
      expect(first.text).toContain('s1')
      await writeFile(path.join(lib, 'schema.txt'), 's2\n')
      const second = await summarized(root, ['lib#use', '--output-logs', 'full'])
      expect(second.code).toBe(0)
      expect(second.tasks.get('lib#use')?.['status']).toBe('success')
      expect(second.text).toContain('s2')
      await writeFile(path.join(lib, 'schema.txt'), 's1\n')
      const back = await summarized(root, ['lib#use', '--output-logs', 'full'])
      expect(back.tasks.get('lib#use')?.['status']).toBe('cache-hit')
      expect(back.text).toContain('s1')
    },
    TIMEOUT,
  )

  it(
    '`file_hashing_hashes_only_requested_graph_scopes` — a change in one project moves only its task and its dependants',
    async () => {
      const before = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      await writeFile(path.join(root, 'packages', 'docs', 'src', 'in.txt'), 'docs2\n')
      const after = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      expect(after.get('docs#build')).not.toBe(before.get('docs#build'))
      expect(after.get('lib#build')).toBe(before.get('lib#build'))
      expect(after.get('app#build')).toBe(before.get('app#build'))
      await writeFile(path.join(root, 'packages', 'docs', 'src', 'in.txt'), 'docs\n')
    },
    TIMEOUT,
  )

  it(
    '`global_hash` global dependencies — vx: a root file moves exactly the tasks that list it',
    async () => {
      const before = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      await writeFile(path.join(root, 'tsconfig.base.json'), '{"strict":true}\n')
      const after = new Map((await dry(root, ['build', '--all'])).map((t) => [t.id, t.hash]))
      expect(after.get('lib#build')).not.toBe(before.get('lib#build'))
      expect(after.get('app#build')).not.toBe(before.get('app#build'))
      expect(after.get('docs#build')).toBe(before.get('docs#build'))
      await writeFile(path.join(root, 'tsconfig.base.json'), '{}\n')
    },
    TIMEOUT,
  )

  it(
    'task definition hashing — a command edit moves that task and its dependants, not a sibling task',
    async () => {
      const ids = ['lib#build', 'app#build', 'lib#lint']
      const of = async () =>
        new Map((await dry(root, ['build', 'lint', '--all'])).map((t) => [t.id, t.hash]))
      const before = await of()
      const cfg = path.join(root, 'packages', 'lib', 'vx.config.mjs')
      const src = await readFile(cfg, 'utf8')
      await writeFile(
        cfg,
        src.replace('date +%N >> dist/out.txt', 'date +%N >> dist/out.txt && true'),
      )
      const after = await of()
      expect(after.get(ids[0]!)).not.toBe(before.get(ids[0]!))
      expect(after.get(ids[1]!)).not.toBe(before.get(ids[1]!))
      expect(after.get(ids[2]!)).toBe(before.get(ids[2]!))
      await writeFile(cfg, src)
    },
    TIMEOUT,
  )
})

describe('Turbo parity — line endings (turborepo-scm)', () => {
  it(
    "`test_crlf_hash_with_autocrlf_true` — divergence: a core.autocrlf checkout keys the CRLF bytes its build reads, so it misses the LF checkout's entries rather than risk a stale hit",
    async () => {
      const lf = await workspace('vx-parity-turbo-crlf-', {
        lib: { config: config("{ files: ['src/**'] }"), files: { 'src/a.txt': 'a\nb\n' } },
      })
      const crlf = `${lf}-crlf`
      try {
        await writeFile(path.join(lf, '.gitattributes'), '* text=auto\n')
        const git = gitIn(lf)
        git('add', '-A')
        git('commit', '-q', '-m', 'eol')
        gitIn(os.tmpdir())('-c', 'core.autocrlf=true', 'clone', '-q', lf, crlf)
        // The clone is clean to git, yet its build reads other bytes.
        expect(gitIn(crlf)('status', '--porcelain', '-uno')).toBe('')
        expect(await readFile(path.join(crlf, 'packages', 'lib', 'src', 'a.txt'), 'utf8')).toBe(
          'a\r\nb\r\n',
        )
        expect(await key(crlf, 'lib#t')).not.toBe(await key(lf, 'lib#t'))
      } finally {
        await rm(crlf, { recursive: true, force: true })
        await rm(lf, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
