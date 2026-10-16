// Nx parity, cache invalidation: the cases Nx's own suites pin (the native
// hashers in packages/nx/src/native/tasks, and hasher/*.spec.ts), each
// ported to vx's CLI. A case names the Nx test it stands in for; a
// deliberate divergence says so in its name. Not ported: `json` field filters, tsconfig path pruning,
// `{cwd}`, external-node hashing (the lockfile plugin's suite), Ultracache,
// and the planner's memo and inspector internals.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry, PARITY_TIMEOUT as TIMEOUT, summarized, vx } from './helpers/parity.js'

const task = (inputs: string, command = 'true', extra = '') =>
  `{ exec: { command: ${JSON.stringify(command)} }, ${extra} inputs: ${inputs}, cache: { outputs: { files: [] } } }`

async function workspace(
  prefix: string,
  projects: Record<string, { tasks: Record<string, string>; files?: Record<string, string> }>,
  edges: Record<string, string[]> = {},
): Promise<string> {
  const root = await makeWorkspace({ prefix, edges })
  for (const [name, spec] of Object.entries(projects)) {
    const tasks = Object.entries(spec.tasks)
      .map(([n, t]) => `    ${n}: ${t},`)
      .join('\n')
    await addProject(root, name, {
      config: `export default {\n  tasks: {\n${tasks}\n  },\n}\n`,
      files: spec.files ?? {},
    })
  }
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return root
}

async function keys(root: string, args: string[], env: Record<string, string> = {}) {
  return new Map((await dry(root, args, env)).map((t) => [t.id, t.hash]))
}

async function key(root: string, id: string, env: Record<string, string> = {}): Promise<string> {
  const hash = (await keys(root, [id], env)).get(id)
  if (hash === undefined) throw new Error(`${id} not planned`)
  return hash
}

describe('Nx parity — native hasher: project files and dependencies', () => {
  let root: string
  const pkg = (name: string) => path.join(root, 'packages', name)
  beforeAll(async () => {
    const tasks = {
      build: task("{ files: ['src/**', '!src/**/*.spec.ts'] }", 'true', "dependsOn: ['^build'],"),
      test: task("{ files: ['src/**'] }"),
      decoupled: task("{ files: ['src/**'], tasks: [] }", 'true', "dependsOn: ['^build'],"),
    }
    const files = (n: string) => ({
      'src/index.ts': `export const ${n} = 1\n`,
      'src/a.spec.ts': 'test\n',
    })
    root = await workspace(
      'vx-parity-nx-native-',
      {
        lib: { tasks, files: files('lib') },
        ui: { tasks, files: files('ui') },
        app: { tasks, files: files('app') },
      },
      { ui: ['lib'], app: ['ui'] },
    )
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`should create a task hash` / `should hash_deterministically` — the same tree keys the same, run after run',
    async () => {
      const a = await keys(root, ['build', 'test', '--all'])
      const b = await keys(root, ['build', 'test', '--all'])
      expect(b).toEqual(a)
      expect(new Set(a.values()).size).toBe(a.size)
    },
    TIMEOUT,
  )

  it(
    '`should hash tasks where the project has dependencies` / `test_collect_transitive_dependencies` — a dependency change moves every dependant, transitively',
    async () => {
      const before = await keys(root, ['build', '--all'])
      await writeFile(path.join(pkg('lib'), 'src', 'index.ts'), 'export const lib = 2\n')
      const after = await keys(root, ['build', '--all'])
      for (const id of ['lib#build', 'ui#build', 'app#build'])
        expect(after.get(id)).not.toBe(before.get(id))
      await writeFile(path.join(pkg('lib'), 'src', 'index.ts'), 'export const lib = 1\n')
      expect(await keys(root, ['build', '--all'])).toEqual(before)
    },
    TIMEOUT,
  )

  it(
    "`^production` excludes spec files — a dependency's spec edit moves its own `test`, no dependant's `build`",
    async () => {
      const before = await keys(root, ['build', 'test', '--all'])
      await writeFile(path.join(pkg('lib'), 'src', 'a.spec.ts'), 'test 2\n')
      const after = await keys(root, ['build', 'test', '--all'])
      expect(after.get('lib#test')).not.toBe(before.get('lib#test'))
      for (const id of ['lib#build', 'ui#build', 'app#build'])
        expect(after.get(id)).toBe(before.get(id))
      await writeFile(path.join(pkg('lib'), 'src', 'a.spec.ts'), 'test\n')
    },
    TIMEOUT,
  )

  it(
    '`should plan non-default filesets` — two targets of one project key their own inputs',
    async () => {
      const before = await keys(root, ['build', 'test', '--filter', 'app'])
      await writeFile(path.join(pkg('app'), 'src', 'b.spec.ts'), 'more\n')
      const after = await keys(root, ['build', 'test', '--filter', 'app'])
      expect(after.get('app#test')).not.toBe(before.get('app#test'))
      expect(after.get('app#build')).toBe(before.get('app#build'))
      await rm(path.join(pkg('app'), 'src', 'b.spec.ts'))
    },
    TIMEOUT,
  )

  it(
    '`default_fallback_and_explicit_empty_overrides_are_distinct` — vx: `inputs.tasks: []` decouples a task from its dependencies',
    async () => {
      const before = await key(root, 'app#decoupled')
      await writeFile(path.join(pkg('lib'), 'src', 'index.ts'), 'export const lib = 3\n')
      expect(await key(root, 'app#decoupled')).toBe(before)
      expect(await key(root, 'app#build')).not.toBe(before)
      await writeFile(path.join(pkg('lib'), 'src', 'index.ts'), 'export const lib = 1\n')
    },
    TIMEOUT,
  )

  it(
    "`dependentTasksOutputFiles` — divergence: a dependant keys its dependency's inputs, never its output files",
    async () => {
      // Nx can hash the `.d.ts` files a dependency wrote; vx folds the
      // dependency's input key instead (principle 5), so an output rewritten
      // with new bytes but the same inputs moves nothing downstream.
      const before = await key(root, 'app#build')
      await mkdir(path.join(pkg('ui'), 'dist'), { recursive: true })
      await writeFile(path.join(pkg('ui'), 'dist', 'index.d.ts'), 'export declare const ui: 2\n')
      expect(await key(root, 'app#build')).toBe(before)
      await rm(path.join(pkg('ui'), 'dist'), { recursive: true })
    },
    TIMEOUT,
  )
})

describe('Nx parity — env, runtime and workspace files (hash_env, hash_runtime, hash_workspace_files)', () => {
  let root: string
  beforeAll(async () => {
    root = await workspace('vx-parity-nx-env-', {
      lib: {
        tasks: {
          env: task("{ files: [], env: ['NX_PARITY_VAR'] }"),
          runtime: task("{ files: [], runtime: ['cat version.txt', 'echo \"a  b\"'] }"),
          shared: task("{ files: [], workspaceRuntime: ['cat tool.txt'] }"),
          root: task("{ files: [], workspaceFiles: ['config/**'] }"),
        },
        files: { 'version.txt': '1\n' },
      },
      ui: {
        tasks: {
          runtime: task("{ files: [], runtime: ['cat version.txt'] }"),
          shared: task("{ files: [], workspaceRuntime: ['cat tool.txt'] }"),
        },
        files: { 'version.txt': '1\n' },
      },
    })
    await writeFile(path.join(root, 'tool.txt'), 't1\n')
    await mkdir(path.join(root, 'config'), { recursive: true })
    await writeFile(path.join(root, 'config', 'a.json'), '{}\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'root files')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    '`should_hash_env_given_they_exist` / `should_provide_a_default_hash_if_one_does_not_exist`',
    async () => {
      const unset = await key(root, 'lib#env')
      expect(await key(root, 'lib#env')).toBe(unset)
      const a = await key(root, 'lib#env', { NX_PARITY_VAR: 'a' })
      expect(a).not.toBe(unset)
      expect(await key(root, 'lib#env', { NX_PARITY_VAR: 'b' })).not.toBe(a)
      expect(await key(root, 'lib#env', { NX_PARITY_VAR: 'a' })).toBe(a)
    },
    TIMEOUT,
  )

  it(
    '`test_hash_runtime` / `runtime_cache_key_is_deterministic` / `hashes_output_of_command_with_quoted_argument`',
    async () => {
      const before = await key(root, 'lib#runtime')
      expect(await key(root, 'lib#runtime')).toBe(before)
      await writeFile(path.join(root, 'packages', 'lib', 'version.txt'), '2\n')
      expect(await key(root, 'lib#runtime')).not.toBe(before)
      await writeFile(path.join(root, 'packages', 'lib', 'version.txt'), '1\n')
      expect(await key(root, 'lib#runtime')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    '`should hash a shared runtime input against each task env` — vx: `runtime` per project, `workspaceRuntime` once for all',
    async () => {
      const before = await keys(root, ['runtime', 'shared', '--all'])
      await writeFile(path.join(root, 'packages', 'ui', 'version.txt'), '9\n')
      await writeFile(path.join(root, 'tool.txt'), 't2\n')
      const after = await keys(root, ['runtime', 'shared', '--all'])
      expect(after.get('lib#runtime')).toBe(before.get('lib#runtime'))
      expect(after.get('ui#runtime')).not.toBe(before.get('ui#runtime'))
      expect(after.get('lib#shared')).not.toBe(before.get('lib#shared'))
      expect(after.get('ui#shared')).not.toBe(before.get('ui#shared'))
      await writeFile(path.join(root, 'packages', 'ui', 'version.txt'), '1\n')
      await writeFile(path.join(root, 'tool.txt'), 't1\n')
    },
    TIMEOUT,
  )

  it(
    '`test_hash_workspace_files` — vx: `workspaceFiles` keys root files; a new file under the glob moves it',
    async () => {
      const before = await key(root, 'lib#root')
      await writeFile(path.join(root, 'config', 'a.json'), '{"x":1}\n')
      const edited = await key(root, 'lib#root')
      expect(edited).not.toBe(before)
      await writeFile(path.join(root, 'config', 'b.json'), '{}\n')
      expect(await key(root, 'lib#root')).not.toBe(edited)
      await rm(path.join(root, 'config', 'b.json'))
      await writeFile(path.join(root, 'config', 'a.json'), '{}\n')
      expect(await key(root, 'lib#root')).toBe(before)
    },
    TIMEOUT,
  )
})

describe('Nx parity — project roots, ignored files and refused spellings', () => {
  it(
    '`should_hash_projects_with_root_as_dot` / `leaves out the files of a project nested below the project root`',
    async () => {
      const root = await workspace('vx-parity-nx-dot-', {
        lib: { tasks: { t: task("{ files: ['src/**'] }") }, files: { 'src/a.txt': 'a\n' } },
      })
      try {
        await writeFile(
          path.join(root, 'vx.config.mjs'),
          `export default { tasks: { t: ${task("{ files: ['**'] }")} } }\n`,
        )
        await writeFile(path.join(root, 'top.txt'), 'top\n')
        gitIn(root)('add', '-A')
        gitIn(root)('commit', '-q', '-m', 'root project')
        const ids = await keys(root, ['t', '--all'])
        const rootId = [...ids.keys()].find((id) => id !== 'lib#t')!
        const before = ids.get(rootId)
        await writeFile(path.join(root, 'packages', 'lib', 'src', 'a.txt'), 'a2\n')
        expect((await keys(root, ['t', '--all'])).get(rootId)).toBe(before)
        await writeFile(path.join(root, 'top.txt'), 'top2\n')
        expect((await keys(root, ['t', '--all'])).get(rootId)).not.toBe(before)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'ignored files are not inputs (Nx default); one named outright is, as with `an_exact_path_changes_the_hash…` under `includeIgnored`',
    async () => {
      const root = await workspace('vx-parity-nx-ignored-', {
        lib: {
          tasks: { t: task("{ files: ['src/**'] }") },
          files: { 'src/a.txt': 'a\n', '.gitignore': 'src/local.env\n' },
        },
      })
      try {
        const before = await key(root, 'lib#t')
        await writeFile(path.join(root, 'packages', 'lib', 'src', 'local.env'), 'X=1\n')
        expect(await key(root, 'lib#t')).toBe(before)
        await writeFile(
          path.join(root, 'packages', 'lib', 'vx.config.mjs'),
          `export default { tasks: { t: ${task("{ files: ['src/**', 'src/local.env'] }")} } }\n`,
        )
        const named = await key(root, 'lib#t')
        await writeFile(path.join(root, 'packages', 'lib', 'src', 'local.env'), 'X=2\n')
        expect(await key(root, 'lib#t')).not.toBe(named)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '`should not treat ^{projectRoot} filesets as named inputs` — divergence: vx refuses `^production` and `{projectRoot}` with what to write',
    async () => {
      for (const glob of ['^production', '{projectRoot}/src/**']) {
        const root = await workspace('vx-parity-nx-refused-', {
          lib: { tasks: { t: task(`{ files: ['${glob}'] }`) }, files: { 'src/a.txt': 'a\n' } },
        })
        try {
          const r = await vx(root, ['run', 'lib#t', '--dry=json'])
          expect(r.code).not.toBe(0)
          expect(r.out + r.err).toContain(glob)
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    },
    TIMEOUT,
  )

  it(
    "`defers_a_task_that_reads_an_upstream_output` — divergence: vx refuses an input glob over another task's outputs",
    async () => {
      const root = await workspace('vx-parity-nx-overlap-', {
        lib: {
          tasks: {
            gen: `{ exec: { command: 'mkdir -p src/gen && echo g > src/gen/x.ts' }, inputs: { files: [] }, cache: { outputs: { files: ['src/gen/**'] } } }`,
            build: task("{ files: ['src/**'] }", 'true', "dependsOn: ['gen'],"),
          },
          files: { 'src/a.ts': 'a\n' },
        },
      })
      try {
        const r = await vx(root, ['run', 'lib#build'])
        expect(r.code).not.toBe(0)
        expect(r.out + r.err).toContain('src/gen/**')
        // Once excluded, the generated file still reaches the build through
        // gen's key, and the run replays nothing stale.
        await writeFile(
          path.join(root, 'packages', 'lib', 'vx.config.mjs'),
          `export default { tasks: {
    gen: { exec: { command: 'mkdir -p src/gen && cat seed.txt > src/gen/x.ts' }, inputs: { files: ['seed.txt'] }, cache: { outputs: { files: ['src/gen/**'] } } },
    build: ${task("{ files: ['src/**', '!src/gen/**'] }", 'cat src/gen/x.ts', "dependsOn: ['gen'],")},
  } }\n`,
        )
        await writeFile(path.join(root, 'packages', 'lib', 'seed.txt'), 'one\n')
        const first = await summarized(root, ['lib#build', '--output-logs', 'full'])
        expect(first.code).toBe(0)
        expect(first.text).toContain('one')
        await writeFile(path.join(root, 'packages', 'lib', 'seed.txt'), 'two\n')
        const second = await summarized(root, ['lib#build', '--output-logs', 'full'])
        expect(second.tasks.get('lib#build')?.['status']).toBe('success')
        expect(second.text).toContain('two')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '`should hash tasks where the project graph has circular dependencies` — a project cycle hashes the tasks that do not cycle',
    async () => {
      const root = await workspace(
        'vx-parity-nx-cycle-',
        {
          lib: { tasks: { lint: task("{ files: ['src/**'] }") }, files: { 'src/a.txt': 'a\n' } },
          ui: { tasks: { lint: task("{ files: ['src/**'] }") }, files: { 'src/a.txt': 'a\n' } },
        },
        { lib: ['ui'], ui: ['lib'] },
      )
      try {
        const before = await keys(root, ['lint', '--all'])
        expect(before.size).toBe(2)
        await writeFile(path.join(root, 'packages', 'lib', 'src', 'a.txt'), 'b\n')
        const after = await keys(root, ['lint', '--all'])
        expect(after.get('lib#lint')).not.toBe(before.get('lib#lint'))
        expect(after.get('ui#lint')).toBe(before.get('ui#lint'))
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// Nx's symlink cases: tasks/hashers/disk_expansion (a fileset reads a link
// where it points) and walker.rs (a linked file is read, a linked directory
// is not entered). vx keys what a link points to wherever it lies, and
// enters a linked directory too (owner, 2026-10-16: "Do like nx", directory
// links included); linked-inputs.test.ts pins the runs and hits.
describe('Nx parity — symlinked inputs', () => {
  let root: string
  let elsewhere: string
  const app = () => path.join(root, 'packages', 'app')
  beforeAll(async () => {
    elsewhere = await mkdtemp(path.join(os.tmpdir(), 'vx-parity-nx-elsewhere-'))
    await writeFile(path.join(elsewhere, 'linked.js'), 'out\n')
    await mkdir(path.join(elsewhere, 'tree'), { recursive: true })
    await writeFile(path.join(elsewhere, 'tree', 'deep.js'), 'deep\n')
    root = await workspace('vx-parity-nx-links-', {
      app: { tasks: { build: task("{ files: ['src/**'] }") }, files: { 'src/a.js': 'a\n' } },
    })
    await symlink(path.join(elsewhere, 'linked.js'), path.join(app(), 'src', 'escape.js'))
    await symlink(path.join(elsewhere, 'tree'), path.join(app(), 'src', 'tree'))
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-q', '-m', 'links')
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  })

  it(
    '`a_link_is_read_where_it_points` — an edit behind a file link out of the workspace moves the key',
    async () => {
      const before = await key(root, 'app#build')
      await writeFile(path.join(elsewhere, 'linked.js'), 'out 2\n')
      expect(await key(root, 'app#build')).not.toBe(before)
      await writeFile(path.join(elsewhere, 'linked.js'), 'out\n')
      expect(await key(root, 'app#build')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    '`a_link_is_read_where_it_points` — vx diverges: a walk enters a linked directory, so an edit beneath it moves the key',
    async () => {
      const before = await key(root, 'app#build')
      await writeFile(path.join(elsewhere, 'tree', 'deep.js'), 'deep 2\n')
      expect(await key(root, 'app#build')).not.toBe(before)
      await writeFile(path.join(elsewhere, 'tree', 'deep.js'), 'deep\n')
      expect(await key(root, 'app#build')).toBe(before)
    },
    TIMEOUT,
  )

  it(
    '`a_walk_follows_its_root_link_but_no_link_it_finds` — vx diverges: a link inside a linked directory is followed too',
    async () => {
      const further = await mkdtemp(path.join(os.tmpdir(), 'vx-parity-nx-further-'))
      try {
        await writeFile(path.join(further, 'further.js'), 'further\n')
        await symlink(further, path.join(elsewhere, 'tree', 'onward'))
        const before = await key(root, 'app#build')
        await writeFile(path.join(further, 'further.js'), 'further 2\n')
        expect(await key(root, 'app#build')).not.toBe(before)
      } finally {
        await rm(path.join(elsewhere, 'tree', 'onward'), { force: true })
        await rm(further, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '`a_link_pointing_at_its_own_workspace_does_not_recurse` — a link to the workspace root keys, and keys the same twice',
    async () => {
      await symlink(root, path.join(app(), 'src', 'loop'))
      try {
        const first = await key(root, 'app#build')
        expect(await key(root, 'app#build')).toBe(first)
      } finally {
        await rm(path.join(app(), 'src', 'loop'), { force: true })
      }
    },
    TIMEOUT,
  )

  it(
    "`walker.rs`: a link's own target is part of what it is — retargeting a link to equal bytes moves the key",
    async () => {
      const before = await key(root, 'app#build')
      await writeFile(path.join(elsewhere, 'twin.js'), 'out\n')
      await rm(path.join(app(), 'src', 'escape.js'))
      await symlink(path.join(elsewhere, 'twin.js'), path.join(app(), 'src', 'escape.js'))
      try {
        expect(await key(root, 'app#build')).not.toBe(before)
      } finally {
        await rm(path.join(app(), 'src', 'escape.js'))
        await symlink(path.join(elsewhere, 'linked.js'), path.join(app(), 'src', 'escape.js'))
      }
      expect(await key(root, 'app#build')).toBe(before)
    },
    TIMEOUT,
  )
})
