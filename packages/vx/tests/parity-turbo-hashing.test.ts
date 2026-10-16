// Turbo parity, cache invalidation: the cases Turbo's own Rust suites pin
// (crates turborepo-scm, turborepo-env, turborepo-task-hash), each ported
// to vx's CLI. A case names the Turbo test it stands in for; a deliberate
// divergence says so in its name. Not ported: symlinked inputs (pinned in
// linked-inputs.test.ts), Vercel's `.env.local` OIDC rotation and Next.js
// env inference (no vx counterpart), and Turbo's internal index, binary
// search and concurrency unit tests (no behaviour a user sees).

import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
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
      cache: { inputs: ${inputs}, outputs: { files: [] } },
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

describe('Turbo parity — scm: which file changes move a key (turborepo-scm)', () => {
  let root: string
  let lib: string
  beforeAll(async () => {
    root = await workspace('vx-parity-turbo-scm-', {
      lib: { config: config("{ files: ['src/**'] }"), files: { 'src/a.txt': 'a\n' } },
      'lib-extra': { config: config("{ files: ['src/**'] }"), files: { 'src/b.txt': 'b\n' } },
    })
    lib = path.join(root, 'packages', 'lib')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`test_modified_tracked_files_detected` — an edit to a tracked file moves the key; undoing it moves it back',
    async () => {
      const clean = await key(root, 'lib#t')
      await writeFile(path.join(lib, 'src', 'a.txt'), 'a2\n')
      expect(await key(root, 'lib#t')).not.toBe(clean)
      await writeFile(path.join(lib, 'src', 'a.txt'), 'a\n')
      expect(await key(root, 'lib#t')).toBe(clean)
    },
    TIMEOUT,
  )

  it(
    '`test_index_and_no_index_agree_on_mixed_state` — dirty, staged and committed bytes key alike',
    async () => {
      const git = gitIn(root)
      await writeFile(path.join(lib, 'src', 'a.txt'), 'a3\n')
      const dirty = await key(root, 'lib#t')
      git('add', '-A')
      // `test_modified_then_staged_file_has_working_tree_hash`
      expect(await key(root, 'lib#t')).toBe(dirty)
      git('commit', '-q', '-m', 'a3')
      expect(await key(root, 'lib#t')).toBe(dirty)
    },
    TIMEOUT,
  )

  it(
    '`test_same_size_content_change_is_modified` — a same-size edit right after a commit moves the key (racy git)',
    async () => {
      const git = gitIn(root)
      await writeFile(path.join(lib, 'src', 'a.txt'), 'xy\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'xy')
      const before = await key(root, 'lib#t')
      await writeFile(path.join(lib, 'src', 'a.txt'), 'yx\n')
      expect(await key(root, 'lib#t')).not.toBe(before)
      await writeFile(path.join(lib, 'src', 'a.txt'), 'xy\n')
    },
    TIMEOUT,
  )

  it(
    '`test_scoped_untracked_files_only_include_selected_package` / `test_prefix_does_not_match_sibling_with_shared_prefix`',
    async () => {
      const before = await key(root, 'lib#t')
      await writeFile(path.join(root, 'packages', 'lib-extra', 'src', 'new.txt'), 'n\n')
      expect(await key(root, 'lib#t')).toBe(before)
      await writeFile(path.join(lib, 'src', 'new.txt'), 'n\n')
      expect(await key(root, 'lib#t')).not.toBe(before)
      await unlink(path.join(lib, 'src', 'new.txt'))
      await unlink(path.join(root, 'packages', 'lib-extra', 'src', 'new.txt'))
      expect(await key(root, 'lib#t')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    '`test_scoped_untracked_files_respect_ancestor_gitignore` / `test_gitignore_negation_patterns`',
    async () => {
      const git = gitIn(root)
      await writeFile(path.join(root, '.gitignore'), '*.log\n!keep.log\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'ignore')
      const before = await key(root, 'lib#t')
      await writeFile(path.join(lib, 'src', 'debug.log'), 'noise\n')
      expect(await key(root, 'lib#t')).toBe(before)
      await writeFile(path.join(lib, 'src', 'keep.log'), 'kept\n')
      expect(await key(root, 'lib#t')).not.toBe(before)
      await unlink(path.join(lib, 'src', 'keep.log'))
      await unlink(path.join(lib, 'src', 'debug.log'))
    },
    TIMEOUT,
  )

  it(
    "`test_gitignore_in_untracked_directory` — a new directory's own .gitignore applies to its files",
    async () => {
      const before = await key(root, 'lib#t')
      await mkdir(path.join(lib, 'src', 'fresh'), { recursive: true })
      await writeFile(path.join(lib, 'src', 'fresh', '.gitignore'), 'secret.txt\n')
      const withIgnore = await key(root, 'lib#t')
      expect(withIgnore).not.toBe(before)
      await writeFile(path.join(lib, 'src', 'fresh', 'secret.txt'), 's\n')
      expect(await key(root, 'lib#t')).toBe(withIgnore)
      await writeFile(path.join(lib, 'src', 'fresh', 'open.txt'), 'o\n')
      expect(await key(root, 'lib#t')).not.toBe(withIgnore)
      await rm(path.join(lib, 'src', 'fresh'), { recursive: true })
      expect(await key(root, 'lib#t')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    '`test_index_equivalence_with_deleted_files` / `…_with_staged_deletion` — a deletion moves the key, staged or not',
    async () => {
      const git = gitIn(root)
      await writeFile(path.join(lib, 'src', 'gone.txt'), 'g\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'gone')
      const before = await key(root, 'lib#t')
      await unlink(path.join(lib, 'src', 'gone.txt'))
      const deleted = await key(root, 'lib#t')
      expect(deleted).not.toBe(before)
      git('rm', '-q', '--cached', 'packages/lib/src/gone.txt')
      expect(await key(root, 'lib#t')).toBe(deleted)
      git('commit', '-q', '-m', 'rm')
      expect(await key(root, 'lib#t')).toBe(deleted)
    },
    TIMEOUT,
  )

  it(
    '`test_superset_prefixes_produce_same_hashes_as_scoped_prefixes` / `versioned_package_filter_and_explicit_task_id_share_a_hash`',
    async () => {
      const alone = await key(root, 'lib#t')
      const all = (await dry(root, ['t', '--all'])).find((t) => t.id === 'lib#t')?.hash
      const filtered = (await dry(root, ['t', '--filter', 'lib'])).find(
        (t) => t.id === 'lib#t',
      )?.hash
      expect(all).toBe(alone)
      expect(filtered).toBe(alone)
    },
    TIMEOUT,
  )

  it(
    '`test_subdirectory_detection` — a run from inside a project keys its task as a run from the root does',
    async () => {
      const fromRoot = await key(root, 'lib#t')
      const proc = Bun.spawn(
        [
          process.execPath,
          path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
          'run',
          'lib#t',
          '--dry=json',
        ],
        {
          cwd: path.join(lib, 'src'),
          env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
          stdout: 'pipe',
        },
      )
      const out = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      const tasks = (JSON.parse(out) as { tasks: Array<{ id: string; hash: string }> }).tasks
      expect(tasks.find((t) => t.id === 'lib#t')?.hash).toBe(fromRoot)
    },
    TIMEOUT,
  )

  it(
    '`test_linked_worktree_detection` / `test_package_hashes_in_external_worktree` — a linked worktree keys as the main checkout',
    async () => {
      const git = gitIn(root)
      const main = await key(root, 'lib#t')
      const wt = path.join(os.tmpdir(), `vx-parity-turbo-wt-${process.pid}`)
      git('worktree', 'add', '-q', wt)
      try {
        expect(await key(wt, 'lib#t')).toBe(main)
        await writeFile(path.join(wt, 'packages', 'lib', 'src', 'a.txt'), 'wt\n')
        expect(await key(wt, 'lib#t')).not.toBe(main)
      } finally {
        git('worktree', 'remove', '--force', wt)
      }
    },
    TIMEOUT,
  )
})

describe('Turbo parity — file hashing: globs and literals (turborepo-scm manual + package_deps)', () => {
  let root: string
  let lib: string
  beforeAll(async () => {
    root = await workspace('vx-parity-turbo-files-', {
      lib: {
        config: config(
          "{ files: ['src/**', '!**/*.md'], workspaceFiles: ['shared/**'] }",
          'true',
          `dir: { exec: { command: 'true' }, cache: { inputs: { files: ['src'] }, outputs: { files: [] } } },
    reversed: { exec: { command: 'true' }, cache: { inputs: { files: ['!**/*.md', 'src/**'] }, outputs: { files: [] } } },
    missing: { exec: { command: 'true' }, cache: { inputs: { files: ['src/**', 'nope.txt'] }, outputs: { files: [] } } },`,
        ),
        files: { 'src/a.txt': 'a\n', 'src/notes.md': '# n\n' },
      },
    })
    await mkdir(path.join(root, 'shared'), { recursive: true })
    await writeFile(path.join(root, 'shared', 'base.json'), '{}\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'shared')
    lib = path.join(root, 'packages', 'lib')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`test_cross_package_input_glob_exclusions` / `test_include_default_files_with_exclusion` — an excluded file moves nothing, in either order',
    async () => {
      const t = await key(root, 'lib#t')
      const reversed = await key(root, 'lib#reversed')
      await writeFile(path.join(lib, 'src', 'notes.md'), '# changed\n')
      expect(await key(root, 'lib#t')).toBe(t)
      expect(await key(root, 'lib#reversed')).toBe(reversed)
      await writeFile(path.join(lib, 'src', 'a.txt'), 'a2\n')
      expect(await key(root, 'lib#t')).not.toBe(t)
      expect(await key(root, 'lib#reversed')).not.toBe(reversed)
    },
    TIMEOUT,
  )

  it(
    '`test_directory_input_matches_all_files_inside` — a directory literal keys every file below it',
    async () => {
      const before = await key(root, 'lib#dir')
      await mkdir(path.join(lib, 'src', 'deep', 'er'), { recursive: true })
      await writeFile(path.join(lib, 'src', 'deep', 'er', 'x.txt'), 'x\n')
      expect(await key(root, 'lib#dir')).not.toBe(before)
      await rm(path.join(lib, 'src', 'deep'), { recursive: true })
      expect(await key(root, 'lib#dir')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    '`test_parent_dir_inputs_are_hashed` / `test_parent_dir_glob_inputs_are_hashed` — vx: `workspaceFiles`',
    async () => {
      const before = await key(root, 'lib#t')
      await writeFile(path.join(root, 'shared', 'base.json'), '{"a":1}\n')
      expect(await key(root, 'lib#t')).not.toBe(before)
      await writeFile(path.join(root, 'shared', 'base.json'), '{}\n')
      expect(await key(root, 'lib#t')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    '`test_missing_explicit_file_errors_with_git` — a named file that is missing keys as absent; creating it moves the key',
    async () => {
      const before = await key(root, 'lib#missing')
      await writeFile(path.join(lib, 'nope.txt'), 'now\n')
      expect(await key(root, 'lib#missing')).not.toBe(before)
      await unlink(path.join(lib, 'nope.txt'))
      expect(await key(root, 'lib#missing')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    "`test_binary_files_hash_raw_with_text_auto` — `* text=auto` never folds a binary file's CRLF away",
    async () => {
      const git = gitIn(root)
      await writeFile(path.join(root, '.gitattributes'), '* text=auto\n')
      await writeFile(path.join(lib, 'src', 'blob.bin'), Buffer.from([0, 1, 13, 10, 2]))
      git('add', '-A')
      git('commit', '-q', '-m', 'bin')
      const before = await key(root, 'lib#t')
      await writeFile(path.join(lib, 'src', 'blob.bin'), Buffer.from([0, 1, 10, 2]))
      expect(await key(root, 'lib#t')).not.toBe(before)
      await writeFile(path.join(lib, 'src', 'blob.bin'), Buffer.from([0, 1, 13, 10, 2]))
    },
    TIMEOUT,
  )
})

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
      cache: { inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, outputs: { files: ['dist/**'] } },
    },
    gen: {
      exec: { command: 'mkdir -p gen && cp schema.txt gen/out.txt' },
      cache: { inputs: { files: ['schema.txt'] }, outputs: { files: ['gen/**'] } },
    },
    use: {
      exec: { command: 'cat gen/out.txt' },
      dependsOn: ['gen'],
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
    lint: {
      exec: { command: 'echo lint-${name}' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
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
