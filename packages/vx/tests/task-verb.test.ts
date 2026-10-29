// `vx build` from a Turbo user's hands, `vx build app` from an Nx user's:
// a task typed where the verb goes is answered with the `vx run` that
// runs it, never a bare "unknown command".

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'

// One test spawns vx 7 times, each `run` locking first: past 5 s on a
// loaded CI worker (2026-10-23).
setDefaultTimeout(30_000)

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TASKS = `export default { tasks: { build: { exec: { command: 'true' } }, dev: { exec: { command: 'true' } } } }`

let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-task-verb-' })
  await addProject(root, 'app', TASKS)
  await addProject(root, 'lib', TASKS)
  // The hints read the lock; the shim locks first only for `run` and `watch`.
  Bun.spawnSync({
    cmd: [process.execPath, path.resolve(import.meta.dir, '..', 'src', 'bin.ts'), 'lock'],
    cwd: root,
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
  })
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(cwd: string, ...args: string[]): [number, string] {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd })
  return [p.exitCode, p.stderr.toString()]
}

describe('a task typed as a verb', () => {
  it('names the vx run that runs it, from the root, a project, or with a project after it', () => {
    expect(vx(root, 'build')).toEqual([
      1,
      noticed('vx: `build` is a task here, not a command (did you mean vx run build --all?)\n'),
    ])
    expect(vx(root, 'build', 'lib')).toEqual([
      1,
      noticed(
        'vx: `build` is a task here, not a command (did you mean vx run build --filter lib?)\n',
      ),
    ])
    expect(vx(path.join(root, 'packages', 'app'), 'build')).toEqual([
      1,
      noticed('vx: `build` is a task here, not a command (did you mean vx run build?)\n'),
    ])
    expect(vx(root, 'app#build')).toEqual([
      1,
      noticed('vx: `app#build` is a task (did you mean vx run app#build?)\n'),
    ])
  })

  it('from a project that does not declare the task, names the run that reaches the ones that do', async () => {
    // `vx run lint` from lib refuses: only projects outside the selection declare it.
    const lock = (): void => {
      Bun.spawnSync({
        cmd: [process.execPath, path.resolve(import.meta.dir, '..', 'src', 'bin.ts'), 'lock'],
        cwd: root,
        env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false' },
      })
    }
    const solo = await addProject(
      root,
      'solo',
      `export default { tasks: { lint: { exec: { command: 'true' } } } }`,
    )
    lock()
    try {
      expect(vx(path.join(root, 'packages', 'lib'), 'lint')).toEqual([
        1,
        noticed('vx: `lint` is a task here, not a command (did you mean vx run lint --all?)\n'),
      ])
      expect(vx(solo, 'lint')).toEqual([
        1,
        noticed('vx: `lint` is a task here, not a command (did you mean vx run lint?)\n'),
      ])
    } finally {
      await rm(solo, { recursive: true, force: true })
      lock()
    }
  })

  it('a `dev` task beats the no-service note; a name no project declares stays unknown', () => {
    expect(vx(root, 'dev')).toEqual([
      1,
      noticed('vx: `dev` is a task here, not a command (did you mean vx run dev --all?)\n'),
    ])
    const [code, err] = vx(root, 'deploy')
    expect(code).toBe(1)
    expect(err.split('\n')[0]).toBe('✗ vx  unknown command: deploy')
  })

  it("Nx's `project:target` on vx run names the `project#task` it means", () => {
    const run = (cwd: string, ...args: string[]): [number, string, string] => {
      const p = Bun.spawnSync({ cmd: [process.execPath, BIN, 'run', ...args], cwd })
      return [p.exitCode, p.stdout.toString(), p.stderr.toString()]
    }
    expect(run(root, 'app:build', 'lib:dev')).toEqual([
      1,
      '',
      noticed(
        "vx run: `app:build lib:dev` is Nx's project:target (did you mean vx run app#build lib#dev?)\n",
      ),
    ])
    expect(run(root, 'app:build', '--all')[2]).toBe(
      noticed('vx run: no projects declare task(s): app:build. Did you mean app#build?\n'),
    )
    expect(run(path.join(root, 'packages', 'lib'), 'lib:build')[2]).toBe(
      noticed('vx run: no projects declare task(s): lib:build. Did you mean lib#build?\n'),
    )
    // A task the project does not declare is no Nx spelling: the plain lines stand.
    expect(run(root, 'app:nope')[2]).toBe(
      noticed(
        'vx run: not inside a project: run from a project directory, or pass --all or --filter <pattern> (see `vx run --help`)\n',
      ),
    )
    expect(run(root, 'app:nope', '--all')[2]).toBe(
      noticed(
        'vx run: no projects declare task(s): app:nope. Tasks: build, dev. A run reads the lock: after editing a vx.config, run `vx lock`.\n',
      ),
    )
    // Nor does one the project inherits from Object.prototype.
    expect(run(root, 'app:toString')[2]).toBe(
      noticed(
        'vx run: not inside a project: run from a project directory, or pass --all or --filter <pattern> (see `vx run --help`)\n',
      ),
    )
  })

  // nx-examples names `@nx-example/cart` `cart`, and its users type
  // `nx run cart:build` and `nx build cart`. And a `pkg#task` run loads
  // pkg alone, so a typo'd pkg was measured against nothing: no hint.
  it("Nx's short name for a scoped package, and a typo'd package, are hinted", async () => {
    const web = await addProject(root, '@s/web', TASKS)
    const run = (...args: string[]): string[] => {
      const p = Bun.spawnSync({ cmd: [process.execPath, BIN, 'run', ...args], cwd: root })
      return [p.stdout.toString(), p.stderr.toString()]
    }
    try {
      expect(run('web:build')[1]).toBe(
        noticed("vx run: `web:build` is Nx's project:target (did you mean vx run @s/web#build?)\n"),
      )
      expect(run('web#build')[1]).toBe(
        noticed('vx run: no projects declare task(s): web#build. Did you mean @s/web#build?\n'),
      )
      expect(run('ap#build')[1]).toBe(
        noticed('vx run: no projects declare task(s): ap#build. Did you mean app#build?\n'),
      )
      expect(vx(root, 'build', 'web')).toEqual([
        1,
        noticed(
          'vx: `build` is a task here, not a command (did you mean vx run build --filter @s/web?)\n',
        ),
      ])
      // Two scopes share the name: none of them is meant.
      const other = await addProject(root, '@t/web', TASKS)
      try {
        expect(run('web:build')[1]).toBe(
          noticed(
            'vx run: not inside a project: run from a project directory, or pass --all or --filter <pattern> (see `vx run --help`)\n',
          ),
        )
      } finally {
        await rm(other, { recursive: true, force: true })
      }
    } finally {
      await rm(web, { recursive: true, force: true })
    }
  })

  it('`vx run` with no task and no terminal names the tasks here', async () => {
    const bare = (cwd: string): string =>
      Bun.spawnSync({ cmd: [process.execPath, BIN, 'run'], cwd, stdin: 'ignore' }).stderr.toString()
    const line = (tasks: string): string =>
      noticed(
        `vx run: missing task name (stdin is not a TTY, so no picker; tasks here: ${tasks}) (see \`vx run --help\`)\n`,
      )
    expect(bare(root)).toBe(line('build, dev'))
    const many = await addProject(
      root,
      'many',
      `export default { tasks: { ${Array.from({ length: 14 }, (_, i) => `t${String(i).padStart(2, '0')}: { exec: { command: 'true' } }`).join(', ')} } }`,
    )
    try {
      expect(bare(many)).toBe(
        line('t00, t01, t02, t03, t04, t05, t06, t07, t08, t09, t10, t11 and 2 more'),
      )
      expect(bare(path.join(root, 'packages', 'lib'))).toBe(line('build, dev'))
    } finally {
      await rm(many, { recursive: true, force: true })
    }
  })

  it('a plugin verb of the same name is the verb', async () => {
    const ws = path.join(root, '.vx/workspace.mjs')
    const before = await Bun.file(ws).text()
    try {
      await writeFile(
        ws,
        `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
          'verbs',
          `{ commands: { build: { description: 'x', run: () => { process.stdout.write('plugin\\n'); return 0 } } } }`,
        )}] }\n`,
      )
      const p = Bun.spawnSync({ cmd: [process.execPath, BIN, 'build'], cwd: root })
      expect([p.exitCode, p.stdout.toString()]).toEqual([0, 'plugin\n'])
    } finally {
      await writeFile(ws, before)
    }
  })
})
