// A project is a directory holding a vx.config (2026-10-14): `vx lock`
// finds them, records each by directory, and a run takes its projects from
// the lock. A project is named by its config's `name`, else by a `discover`
// plugin, else by its root-relative path, `//` for the root. Core reads no
// package.json and no package-manager member list.
// Design: docs/design/language-agnostic-core-2026-10.md (PR 5).
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { gitIn, gitInit } from './helpers/workspace.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

function vx(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
      CI: '',
      GITHUB_ACTIONS: '',
      VX_LOCK_REVIEW_FILES: 'false',
    },
  })
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() }
}

/** The task ids `vx run <tasks…> --dry=json` plans, or the refusal. */
function planned(cwd: string, ...args: string[]): string[] | string {
  const r = vx(cwd, 'run', ...args, '--dry=json')
  if (r.code !== 0) return `exit ${r.code}: ${r.err.trim()}`
  return (JSON.parse(r.out.slice(r.out.indexOf('{'))) as { tasks: { id: string }[] }).tasks
    .map((t) => t.id)
    .sort()
}

async function write(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

/** A config whose `hello` task echoes; `extra` lands in the object. */
const config = (extra = ''): string =>
  `export default { ${extra}tasks: { hello: { exec: { command: 'echo hi' } } } }\n`

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-project-dirs-'))
  await write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  gitInit(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** `.vx/workspace.mjs` with a plugin whose `discover` names `dir` `name`. */
async function namingPlugin(dir: string, name: string): Promise<void> {
  await write(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
      'vx-test-namer',
      `{ discover: () => [{ dir: ${JSON.stringify(dir)}, name: ${JSON.stringify(name)} }] }`,
    )}] }\n`,
  )
}

describe('a project is a directory with a vx.config', () => {
  it(
    'a directory holding only a vx.config is a project named by its path',
    async () => {
      await write(path.join(root, 'tools/gen/vx.config.mjs'), config())
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['tools/gen#hello'])
    },
    TIMEOUT,
  )

  // Other runners skipped a directory starting with a dot or holding
  // `__x__`, and took two directories of one base name for one project.
  it(
    'dot directories, underscored names and one base name at two paths are each a project',
    async () => {
      for (const dir of [
        '.config/c',
        '.dotdir/d',
        'libs/__generated__',
        'libs/_x_',
        'x/same',
        'y/same',
      ])
        await write(path.join(root, dir, 'vx.config.mjs'), config())
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual([
        '.config/c#hello',
        '.dotdir/d#hello',
        'libs/__generated__#hello',
        'libs/_x_#hello',
        'x/same#hello',
        'y/same#hello',
      ])
    },
    TIMEOUT,
  )

  // A workspace path with a space broke module resolution and spawns elsewhere.
  it(
    'a workspace and project at paths holding spaces and parentheses run, hit and restore',
    async () => {
      const spaced = await mkdtemp(path.join(os.tmpdir(), 'vx dirs (x) '))
      try {
        await write(path.join(spaced, '.vx/workspace.mjs'), 'export default {}\n')
        gitInit(spaced)
        const dir = path.join(spaced, 'my app (1)')
        await write(
          path.join(dir, 'vx.config.mjs'),
          `export default { tasks: { build: {
            exec: { command: 'echo ran >> runs.log && mkdir -p dist && cp "src/in put.txt" dist/out.txt && pwd > dist/cwd.txt' },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
          } } }\n`,
        )
        await write(path.join(dir, 'src/in put.txt'), 'v1\n')
        expect(vx(spaced, 'lock').code).toBe(0)
        const read = (f: string) => Bun.file(path.join(dir, f)).text()
        expect(vx(spaced, 'run', 'my app (1)#build').code).toBe(0)
        expect(await read('dist/cwd.txt')).toBe(`${await realpath(dir)}\n`)
        await rm(path.join(dir, 'dist'), { recursive: true })
        expect(vx(spaced, 'run', 'my app (1)#build').code).toBe(0)
        expect([await read('runs.log'), await read('dist/out.txt')]).toEqual(['ran\n', 'v1\n'])
      } finally {
        await rm(spaced, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'the root project is named `//`',
    async () => {
      await write(path.join(root, 'vx.config.mjs'), config())
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['//#hello'])
      expect(planned(root, '//#hello')).toEqual(['//#hello'])
    },
    TIMEOUT,
  )

  it(
    "`name` in the config wins over a plugin's name and the path",
    async () => {
      await write(path.join(root, 'apps/web/vx.config.mjs'), config("name: 'web', "))
      await write(path.join(root, 'apps/api/vx.config.mjs'), config())
      await namingPlugin('apps/web', 'plugin-web')
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['apps/api#hello', 'web#hello'])
      // CONTROL: without the config's name the plugin's wins over the path.
      await namingPlugin('apps/api', 'plugin-api')
      expect(planned(root, 'hello', '--all')).toEqual(['plugin-api#hello', 'web#hello'])
    },
    TIMEOUT,
  )

  it(
    'two projects of one name are refused, naming both directories',
    async () => {
      await write(path.join(root, 'a/vx.config.mjs'), config("name: 'same', "))
      await write(path.join(root, 'b/vx.config.mjs'), config("name: 'same', "))
      const r = vx(root, 'lock')
      expect([r.code, r.err.trim()]).toEqual([
        1,
        '✗ vx lock  lock not written\n\n  two projects are named "same": a and b — give one another `name` in its vx.config',
      ])
    },
    TIMEOUT,
  )

  it(
    'a config git ignores is no project',
    async () => {
      await write(path.join(root, '.gitignore'), 'scratch/\n')
      await write(path.join(root, 'scratch/vx.config.mjs'), config())
      await write(path.join(root, 'kept/vx.config.mjs'), config())
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['kept#hello'])
    },
    TIMEOUT,
  )

  it(
    "a config at or under a nested .vx/workspace is that workspace's, not this one's",
    async () => {
      await write(path.join(root, 'inner/.vx/workspace.mjs'), 'export default {}\n')
      await write(path.join(root, 'inner/vx.config.mjs'), config())
      await write(path.join(root, 'inner/pkg/vx.config.mjs'), config())
      await write(path.join(root, 'outer/vx.config.mjs'), config())
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['outer#hello'])
    },
    TIMEOUT,
  )

  // git lists no ignored `.vx/`, so the outer lock claimed inner/pkg while a
  // run from inner/pkg took inner as its root.
  it(
    'a nested workspace whose .vx/ git ignores keeps its projects',
    async () => {
      await write(path.join(root, '.gitignore'), '.vx/\n')
      await write(path.join(root, 'inner/.vx/workspace.mjs'), 'export default {}\n')
      await write(path.join(root, 'inner/vx.config.mjs'), config())
      await write(path.join(root, 'inner/pkg/vx.config.mjs'), config())
      await write(path.join(root, 'outer/vx.config.mjs'), config())
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['outer#hello'])
      expect(vx(path.join(root, 'inner'), 'lock').code).toBe(0)
      expect(planned(path.join(root, 'inner/pkg'), 'hello', '--all')).toEqual([
        '//#hello',
        'pkg#hello',
      ])
    },
    TIMEOUT,
  )

  it(
    'a config added after `vx lock` does not run until locked',
    async () => {
      await write(path.join(root, 'a/vx.config.mjs'), config())
      expect(vx(root, 'lock').code).toBe(0)
      await write(path.join(root, 'b/vx.config.mjs'), config())
      expect(planned(root, 'hello', '--all')).toEqual(['a#hello'])
      const check = vx(root, 'lock', '--check')
      expect([check.code, check.err.trim()]).toEqual([
        1,
        "✗ vx lock --check  b/vx.config.mjs is not in the lock — run 'vx lock'",
      ])
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['a#hello', 'b#hello'])
    },
    TIMEOUT,
  )

  it(
    'a lock of version 2 is refused with the fix',
    async () => {
      await write(path.join(root, 'a/vx.config.mjs'), config())
      await write(
        path.join(root, '.vx/projects.lock.json'),
        JSON.stringify({ version: 2, projects: { a: { tasks: {} } } }),
      )
      expect(planned(root, 'hello', '--all')).toBe(
        'exit 1: ✗ vx run  .vx/projects.lock.json has unsupported version 2 (this vx expects 4) — re-run `vx lock`',
      )
    },
    TIMEOUT,
  )

  it(
    'a pnpm-workspace.yaml member with no config and no plugin is no project',
    async () => {
      await write(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
      await write(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
      await write(
        path.join(root, 'packages/lib/package.json'),
        JSON.stringify({ name: 'lib', scripts: { hello: 'echo lib' } }),
      )
      await write(path.join(root, 'packages/app/vx.config.mjs'), config())
      await write(path.join(root, 'packages/app/package.json'), JSON.stringify({ name: 'app' }))
      expect(vx(root, 'lock').code).toBe(0)
      expect(planned(root, 'hello', '--all')).toEqual(['packages/app#hello'])
    },
    TIMEOUT,
  )
})

describe('--affected without a plugin: containment and task edges only', () => {
  it(
    'a change goes to its deepest owning project and on through task edges',
    async () => {
      const git = gitIn(root)
      await write(path.join(root, '.gitignore'), '.vx/cache/\n')
      await write(path.join(root, 'vx.config.mjs'), config())
      await write(
        path.join(root, 'lib/vx.config.mjs'),
        `export default { tasks: { hello: { exec: { command: 'echo lib' }, inputs: { files: ['**'] }, cache: { outputs: { files: [] } } } } }\n`,
      )
      await write(path.join(root, 'lib/src/a.txt'), 'a\n')
      await write(
        path.join(root, 'app/vx.config.mjs'),
        `export default { tasks: { hello: { dependsOn: ['lib#hello'], exec: { command: 'echo app' } } } }\n`,
      )
      // A manifest edge core does not read: `other` depends on `lib` only by package.json.
      await write(path.join(root, 'other/vx.config.mjs'), config())
      await write(
        path.join(root, 'other/package.json'),
        JSON.stringify({ name: 'other', dependencies: { lib: 'workspace:*' } }),
      )
      await write(path.join(root, 'lib/package.json'), JSON.stringify({ name: 'lib' }))
      expect(vx(root, 'lock').code).toBe(0)
      git('add', '-A')
      git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init')
      await write(path.join(root, 'lib/src/a.txt'), 'b\n')
      expect(planned(root, 'hello', '--affected=HEAD')).toEqual(['app#hello', 'lib#hello'])
      // A root file no other project holds is the root project's, and goes no further.
      git('-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'two')
      await write(path.join(root, 'README.md'), 'docs\n')
      expect(planned(root, 'hello', '--affected=HEAD')).toEqual(['//#hello'])
    },
    TIMEOUT,
  )
})
