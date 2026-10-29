// Turbo parity, cache invalidation: the cases Turbo's own Rust suites pin
// (crates turborepo-scm, turborepo-env, turborepo-task-hash), each ported
// to vx's CLI. A case names the Turbo test it stands in for; a deliberate
// divergence says so in its name. Not ported: symlinked inputs (pinned in
// linked-inputs.test.ts), Vercel's `.env.local` OIDC rotation and Next.js
// env inference (no vx counterpart), and Turbo's internal index, binary
// search and concurrency unit tests (no behaviour a user sees).

import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry, PARITY_TIMEOUT as TIMEOUT } from './helpers/parity.js'

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

  // vercel/turborepo#13245: an intent-to-add entry holds the empty blob's
  // OID in the index, which must never stand in for the bytes on disk.
  it(
    '`git add -N` (intent to add) — the file keys its bytes, and an edit moves the key',
    async () => {
      const git = gitIn(root)
      const before = await key(root, 'lib#t')
      await writeFile(path.join(lib, 'src', 'ita.txt'), 'one\n')
      git('add', '-N', 'packages/lib/src/ita.txt')
      const added = await key(root, 'lib#t')
      expect(added).not.toBe(before)
      await writeFile(path.join(lib, 'src', 'ita.txt'), 'two\n')
      expect(await key(root, 'lib#t')).not.toBe(added)
      git('rm', '-q', '--cached', 'packages/lib/src/ita.txt')
      await unlink(path.join(lib, 'src', 'ita.txt'))
      expect(await key(root, 'lib#t')).toBe(before)
    },
    TIMEOUT,
  )

  // vercel/turborepo#12096
  it(
    '`test_nested_gitignore_scoping` / `test_empty_directories_on_disk` — a nested .gitignore ignores only below it; an empty directory keys nothing',
    async () => {
      const git = gitIn(root)
      await mkdir(path.join(lib, 'src', 'a'), { recursive: true })
      await writeFile(path.join(lib, 'src', 'a', '.gitignore'), 'x.txt\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'nested ignore')
      const before = await key(root, 'lib#t')
      await writeFile(path.join(lib, 'src', 'a', 'x.txt'), 'x\n')
      await mkdir(path.join(lib, 'src', 'empty', 'deeper'), { recursive: true })
      expect(await key(root, 'lib#t')).toBe(before)
      await mkdir(path.join(lib, 'src', 'b'), { recursive: true })
      await writeFile(path.join(lib, 'src', 'b', 'x.txt'), 'x\n')
      expect(await key(root, 'lib#t')).not.toBe(before)
      await rm(path.join(lib, 'src', 'b'), { recursive: true })
      await rm(path.join(lib, 'src', 'empty'), { recursive: true })
      await rm(path.join(lib, 'src', 'a', 'x.txt'))
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
          `dir: { exec: { command: 'true' }, inputs: { files: ['src'] }, cache: { outputs: { files: [] } } },
    reversed: { exec: { command: 'true' }, inputs: { files: ['!**/*.md', 'src/**'] }, cache: { outputs: { files: [] } } },
    missing: { exec: { command: 'true' }, inputs: { files: ['src/**', 'nope.txt'] }, cache: { outputs: { files: [] } } },
    plain: { exec: { command: 'true' }, inputs: { files: ['src/**', 'gen/**', 'logs/**', '!gen', '!logs/**', '!src/skip.txt'] }, cache: { outputs: { files: [] } } },`,
        ),
        files: {
          'src/a.txt': 'a\n',
          'src/notes.md': '# n\n',
          'src/skip.txt': 's\n',
          'gen/x.txt': 'x\n',
          'logs/y.log': 'y\n',
        },
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
    '`plain_exclusions_walk_like_wax_exclusions` (turborepo#14510) — `!dir`, `!dir/**` and `!file` each take back what they name, at any depth',
    async () => {
      const before = await key(root, 'lib#plain')
      await mkdir(path.join(lib, 'gen', 'deep'), { recursive: true })
      for (const file of ['gen/x.txt', 'gen/deep/z.txt', 'logs/y.log', 'src/skip.txt']) {
        await writeFile(path.join(lib, file), 'changed\n')
      }
      expect(await key(root, 'lib#plain')).toBe(before)
      await writeFile(path.join(lib, 'src', 'a.txt'), 'a3\n')
      expect(await key(root, 'lib#plain')).not.toBe(before)
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
