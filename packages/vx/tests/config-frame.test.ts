// A config refusal names its line and shows it (`util/config-frame.ts`).

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { configErrorFrame } from '../src/util/index.js'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

const CONFIG = `export default {
  tasks: {
    build: {
      exec: { command: 'true' },
    },
    'lint.fix': {
      exec: { comand: 'x', timeout: -1 },
    },
  },
}
`

describe('configErrorFrame', () => {
  let dir: string
  let file: string
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-frame-'))
    file = path.join(dir, 'vx.config.ts')
    await writeFile(file, CONFIG)
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('names the field at line:col and frames the lines above it', () => {
    expect(configErrorFrame(`${file}: tasks.lint.fix.exec has unknown field "comand"`, dir)).toBe(
      'vx.config.ts:7:15: tasks.lint.fix.exec has unknown field "comand"\n\n' +
        '  5 |     },\n' +
        "  6 |     'lint.fix': {\n" +
        "> 7 |       exec: { comand: 'x', timeout: -1 },\n" +
        '    |               ^',
    )
  })

  it('finds a path field after the one before it, and a quoted dotted task name', () => {
    // `exec` appears under build first; the walk starts past `lint.fix`.
    expect(
      configErrorFrame(
        `${file}: tasks.lint.fix.exec.timeout must be a positive integer`,
        dir,
      )?.split('\n')[0],
    ).toBe('vx.config.ts:7:28: tasks.lint.fix.exec.timeout must be a positive integer')
    expect(configErrorFrame(`${file}: tasks.build: \`exec\` is odd`, dir)?.split('\n')[0]).toBe(
      'vx.config.ts:4:7: tasks.build: `exec` is odd',
    )
  })

  it('leaves a message it cannot place as it was', () => {
    expect(configErrorFrame(`${file}: tasks.nope.exec has unknown field "x"`, dir)).toBeUndefined()
    expect(configErrorFrame(`${file}: \`tags\` must be an array`, dir)).toBeUndefined()
    expect(configErrorFrame(`${dir}/missing/vx.config.ts: tasks.build x`, dir)).toBeUndefined()
    expect(configErrorFrame('no projects declare task(s): biuld', dir)).toBeUndefined()
    // Standing outside the file's tree, the path stays absolute.
    expect(
      configErrorFrame(`${file}: tasks.build: \`exec\` is odd`, path.join(dir, 'sub'))?.split(
        '\n',
      )[0],
    ).toBe(`${file}:4:7: tasks.build: \`exec\` is odd`)
  })
  it("frames a syntax error at the loader's line:col", () => {
    // Bun's BuildMessage, as the loader words it: no field, a position.
    expect(configErrorFrame(`Project config ${file}:7:15: Expected "}" but found "x"`, dir)).toBe(
      'vx.config.ts:7:15: Expected "}" but found "x"\n\n' +
        '  5 |     },\n' +
        "  6 |     'lint.fix': {\n" +
        "> 7 |       exec: { comand: 'x', timeout: -1 },\n" +
        '    |               ^',
    )
  })

  it('frames a .vx/workspace.ts field too', async () => {
    await mkdir(path.join(dir, '.vx'), { recursive: true })
    const ws = path.join(dir, '.vx', 'workspace.ts')
    await writeFile(ws, 'export default {\n  concurrency: 4,\n}\n')
    expect(
      configErrorFrame(`${ws} has unknown field "concurrency" (allowed: cache, run)`, dir),
    ).toBe(
      '.vx/workspace.ts:2:3 has unknown field "concurrency" (allowed: cache, run)\n\n' +
        '  1 | export default {\n' +
        '> 2 |   concurrency: 4,\n' +
        '    |   ^',
    )
  })
})

describe('vx lock prints a config refusal with its frame', () => {
  it('on stderr, under its refusal line', async () => {
    // Canonical: a macOS temp dir is reached through a symlink.
    const root = await realpath(await makeWorkspace({ prefix: 'vx-frame-e2e-' }))
    try {
      const pkg = path.join(root, 'packages', 'b')
      await mkdir(pkg, { recursive: true })
      await writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'b', version: '0.0.0' }),
      )
      await writeFile(path.join(pkg, 'vx.config.mjs'), CONFIG.replace("'lint.fix'", 'lint'))
      const r = Bun.spawnSync(['bun', BIN, 'lock'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode).toBe(1)
      const err = r.stderr.toString()
      expect(err).toStartWith(
        '✗ vx lock  lock not written\n\n  packages/b/vx.config.mjs:7:15\n  tasks.lint.exec has unknown field "comand"',
      )
      expect(err).toContain(
        "  > 7 |       exec: { comand: 'x', timeout: -1 },\n      |               ^\n",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a syntax error too, at the line Bun places it', async () => {
    const root = await realpath(await makeWorkspace({ prefix: 'vx-frame-syntax-' }))
    try {
      const pkg = path.join(root, 'packages', 'b')
      await mkdir(pkg, { recursive: true })
      await writeFile(path.join(pkg, 'vx.config.mjs'), 'export default {\n  tasks: {}\n')
      const r = Bun.spawnSync(['bun', BIN, 'lock'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode).toBe(1)
      const err = r.stderr.toString()
      expect(err).toStartWith(
        '✗ vx lock  lock not written\n\n  packages/b/vx.config.mjs:2:12\n  Expected "}" but found end of file\n',
      )
      expect(err).toContain('  > 2 |   tasks: {}\n      |            ^\n')
      expect(err).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A rename after an upgrade refuses every config at once; naming one a run
  // made a large repo take a run per config.
  it('names every config that does not load, not only the first', async () => {
    const root = await realpath(await makeWorkspace({ prefix: 'vx-frame-all-' }))
    try {
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
        const pkg = path.join(root, 'packages', name)
        await mkdir(pkg, { recursive: true })
        await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
        await writeFile(
          path.join(pkg, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'x' }, outputs: ['dist'] } } }\n`,
        )
      }
      const r = Bun.spawnSync(['bun', BIN, 'lock'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode).toBe(1)
      const err = r.stderr.toString()
      expect(err).toStartWith(
        '✗ vx lock  lock not written\n\n  packages/a/vx.config.mjs:1:60\n  tasks.build has unknown field "outputs"\n  allowed: cache, dependsOn, description, exec, inputs',
      )
      expect(err).toContain('  fix  use `cache.outputs.files`')
      expect(err.match(/^✗ vx lock {2}also refused$/gm)).toHaveLength(4)
      for (const name of ['b', 'c', 'd', 'e'])
        expect(err).toContain(`packages/${name}/vx.config.mjs:1:60`)
      expect(err).toContain('✗ vx lock  2 more configs refused; fix these, then run vx lock again')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
