// A config refusal names its line and shows it (`util/config-frame.ts`).

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { configErrorFrame, configRefusal } from '../src/util/index.js'
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

  it('frames a refused key at the key, a refused value at its field', async () => {
    const env = path.join(dir, 'env', 'vx.config.ts')
    await mkdir(path.dirname(env), { recursive: true })
    await writeFile(
      env,
      "export default {\n  tasks: {\n    b: { exec: { command: 'x', env: {\n      define: { OK: '1', 'A=B': 'x' },\n      passThrough: ['my.var'],\n    } } },\n  },\n}\n",
    )
    const at = (m: string) =>
      configErrorFrame(m, path.join(dir, 'env'))?.split('\n')[0]?.split(': ')[0]
    expect(at(`${env}: tasks.b.exec.env.define: "A=B" is not an env var name`)).toBe(
      'vx.config.ts:4:27',
    )
    // An array holds no key: its field.
    expect(at(`${env}: tasks.b.exec.env.passThrough: "my.var" is not a shell variable name`)).toBe(
      'vx.config.ts:5:7',
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
  // A field the task leaves out was found in the NEXT task that has it:
  // `tasks.after.outputs is required` framed noout's `outputs`.
  it('frames a missing field at its parent, never at a later task that has it', async () => {
    const other = path.join(dir, 'missing-field', 'vx.config.ts')
    await mkdir(path.dirname(other), { recursive: true })
    await writeFile(
      other,
      `export default {
  tasks: {
    after: { cache: true, exec: { command: 'x' } },
    noout: { outputs: { files: ['dist/**'] }, cache: true },
    plain: { exec: 'x' },
    later: { exec: { timeout: 1 } },
  },
}
`,
    )
    const at = (m: string) => configErrorFrame(`${other}: ${m}`, dir)?.split('\n')[0]
    expect(at('tasks.after.outputs is required when `cache` is set')).toBe(
      'missing-field/vx.config.ts:3:5: tasks.after.outputs is required when `cache` is set',
    )
    // A value that is no object literal holds no field to search.
    expect(at('tasks.plain.exec.timeout must be a positive integer')).toBe(
      'missing-field/vx.config.ts:5:14: tasks.plain.exec.timeout must be a positive integer',
    )
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

  it('frames an import nothing provides at its specifier, and a default that is no object', async () => {
    const imports = path.join(dir, 'imports', '.vx', 'workspace.ts')
    await mkdir(path.dirname(imports), { recursive: true })
    await writeFile(
      imports,
      "import { a } from './a'\nimport x from 'nope-pkg'\n\nexport default defineConfig(() => ({}))\n",
    )
    const cwd = path.join(dir, 'imports')
    expect(
      configErrorFrame(
        `Workspace config ${imports}: cannot find 'nope-pkg' — no node_modules above the config provides it; install the workspace's dependencies first`,
        cwd,
      ),
    ).toBe(
      ".vx/workspace.ts:2:15: cannot find 'nope-pkg' — no node_modules above the config provides it; install the workspace's dependencies first\n\n" +
        "  1 | import { a } from './a'\n" +
        "> 2 | import x from 'nope-pkg'\n" +
        '    |               ^',
    )
    expect(
      configErrorFrame(
        `Workspace config at ${imports} did not export a default object: it exports a function`,
        cwd,
      )?.split('\n')[0],
    ).toBe('.vx/workspace.ts:4:1: did not export a default object: it exports a function')
    // No `export default`: at the named export written instead.
    await writeFile(imports, 'export const config = {}\n')
    expect(
      configErrorFrame(`Workspace config at ${imports} did not export a default object`, cwd),
    ).toBe(
      '.vx/workspace.ts:1:1: did not export a default object\n\n> 1 | export const config = {}\n    | ^',
    )
    // No export at all: the message as it was.
    await writeFile(imports, 'const config = {}\n')
    expect(
      configErrorFrame(`Workspace config at ${imports} did not export a default object`, cwd),
    ).toBeUndefined()
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

  it('frames a backticked setting, nested or not, and a refused task name', async () => {
    const ws = path.join(dir, 'named', '.vx', 'workspace.ts')
    await mkdir(path.dirname(ws), { recursive: true })
    await writeFile(
      ws,
      "export default {\n  cache: { dir: '' },\n  run: { schedule: 'x', concurrenc: 2 },\n}\n",
    )
    const cfg = path.join(dir, 'named', 'vx.config.ts')
    await writeFile(
      cfg,
      "export default {\n  tags: 'a',\n  tasks: {\n    'x#y': { exec: { command: 'x' } },\n  },\n}\n",
    )
    const at = (m: string) =>
      configErrorFrame(m, path.join(dir, 'named'))?.split('\n')[0]?.split(': ')[0]
    expect(at(`${ws}: \`run.schedule\` must be one of 'most-work'`)).toBe('.vx/workspace.ts:3:10')
    expect(at(`${ws}: \`run\` has unknown field "concurrenc" (allowed: retries)`)).toBe(
      '.vx/workspace.ts:3:25',
    )
    expect(at(`${ws}: \`cache.dir\` must be a non-blank path`)).toBe('.vx/workspace.ts:2:12')
    expect(at(`${cfg}: \`tags\` must be an array of non-empty strings`)).toBe('vx.config.ts:2:3')
    expect(at(`${cfg}: task name "x#y" holds '#', which separates a project from its task`)).toBe(
      'vx.config.ts:4:6',
    )
    // An empty name and one with a control character were not framed: the
    // message fell back to the absolute path. An empty key is always
    // quoted, and the source spells a control character as an escape.
    const odd = path.join(dir, 'odd', 'vx.config.ts')
    await mkdir(path.dirname(odd), { recursive: true })
    await writeFile(
      odd,
      "export default {\n  tasks: {\n    a: { exec: { command: 'x' } },\n    '': { exec: { command: 'x' } },\n    '\\u001b[31mred': {},\n  },\n}\n",
    )
    const atOdd = (m: string) =>
      configErrorFrame(m, path.join(dir, 'odd'))?.split('\n')[0]?.split(': ')[0]
    // A plugin is an element: framed at it, not at the config's head.
    const plugins = path.join(dir, 'plugins', '.vx', 'workspace.ts')
    await mkdir(path.dirname(plugins), { recursive: true })
    await writeFile(
      plugins,
      "export default {\n  plugins: [\n    a({ x: [1, 2] }), // b, c\n    's,t',\n    { name: 'p' },\n  ],\n}\n",
    )
    const atPlugin = (m: string) =>
      configErrorFrame(m, path.join(dir, 'plugins'))?.split('\n')[0]?.split(': ')[0]
    expect(atPlugin(`${plugins}: \`plugins[1]\` must be an object`)).toBe('.vx/workspace.ts:4:5')
    expect(
      atPlugin(`${plugins}: \`plugins[2].name\` overrides the package name ('p' over 'q')`),
    ).toBe('.vx/workspace.ts:5:5')
    expect(atPlugin(`${plugins}: \`plugins[0]\` must come from definePlugin`)).toBe(
      '.vx/workspace.ts:3:5',
    )
    // Past the last element: the array itself.
    expect(atPlugin(`${plugins}: \`plugins[7]\` must be an object`)).toBe('.vx/workspace.ts:2:3')
    // A dependency rule is an element of a nested list: its message split
    // the code span (`run.rules.dependencies`[0].deny) and went unframed.
    const rules = path.join(dir, 'rules', '.vx', 'workspace.ts')
    await mkdir(path.dirname(rules), { recursive: true })
    await writeFile(
      rules,
      "export default {\n  run: {\n    rules: {\n      dependencies: [\n        { from: 'a', deny: ['b'] },\n        { from: 'tag:lib', deny: 'tag:app' },\n      ],\n    },\n  },\n}\n",
    )
    expect(
      configErrorFrame(
        `${rules}: \`run.rules.dependencies[1].deny\` must be an array of selectors like 'tag:lib'`,
        path.join(dir, 'rules'),
      )?.split('\n')[0],
    ).toStartWith('.vx/workspace.ts:6:9')
    expect(atOdd(`${odd}: task name "" is empty`)).toBe('vx.config.ts:4:6')
    expect(
      atOdd(`${odd}: task name ${JSON.stringify('\u001b[31mred')} holds a control character`),
    ).toBe('vx.config.ts:5:6')
  })
})

// A field set in a file the config imports was framed at the consumer's
// `test: testTask`, or (spread from a preset) not at all, and the file
// that held the typo was never named.
describe('a refusal of a field an imported file holds', () => {
  let dir: string
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-frame-import-')))
    await mkdir(path.join(dir, 'config'), { recursive: true })
    await mkdir(path.join(dir, 'packages', 'a'), { recursive: true })
    await mkdir(path.join(dir, 'packages', 'presets'), { recursive: true })
    await writeFile(
      path.join(dir, 'config', 'tasks.ts'),
      "export const testTask = {\n  exec: { command: 'x' },\n  input: { files: [] },\n}\n",
    )
    await writeFile(
      path.join(dir, 'packages', 'presets', 'index.ts'),
      "export function lib() {\n  return { build: { exec: { command: 'x' }, outputs: { file: [] } } }\n}\n",
    )
    await writeFile(
      path.join(dir, 'packages', 'a', 'vx.config.ts'),
      "import { lib } from '../presets/index.ts'\nimport { testTask } from '../../config/tasks.ts'\n" +
        'export default { tasks: { ...lib(), test: testTask } }\n',
    )
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('frames the imported file, names the config it reached, keeps the fix', () => {
    const file = path.join(dir, 'packages', 'a', 'vx.config.ts')
    expect(
      configRefusal(
        `${file}: tasks.test has unknown field "input" (allowed: exec, inputs) — did you mean inputs?`,
        dir,
      ),
    ).toEqual({
      where: 'config/tasks.ts:3:3',
      problem: 'tasks.test has unknown field "input"',
      allowed: 'exec, inputs',
      fix: 'use inputs',
      via: 'packages/a/vx.config.ts',
      frame:
        '  1 | export const testTask = {\n' +
        "  2 |   exec: { command: 'x' },\n" +
        '> 3 |   input: { files: [] },\n' +
        '    |   ^',
    })
    expect(
      configRefusal(
        `${file}: tasks.build.outputs has unknown field "file" (allowed: clean, files) — did you mean files?`,
        dir,
      ),
    ).toMatchObject({ where: 'packages/presets/index.ts:2:56', fix: 'use files' })
  })

  it('follows a default export spread, frames a field a held object leaves out at it, not a call', async () => {
    const pkg = path.join(dir, 'packages', 'b')
    await mkdir(pkg, { recursive: true })
    await writeFile(
      path.join(dir, 'config', 'base.ts'),
      "export const base = {\n  tasks: { lint: { exec: { comand: 'x' } } },\n}\n",
    )
    const spread = path.join(pkg, 'vx.config.ts')
    await writeFile(
      spread,
      "import { base } from '../../config/base.ts'\nexport default { ...base, tags: [] }\n",
    )
    const file = path.join(pkg, 'more', 'vx.config.ts')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      "import { testTask } from '../../../config/tasks.ts'\nconst make = (o) => o\n" +
        "export default { tasks: { test: testTask, mk: make({ exec: { comand: 'x' } }) } }\n",
    )
    expect(configRefusal(`${spread}: tasks.lint.exec has unknown field "comand"`, dir)?.where).toBe(
      'config/base.ts:2:28',
    )
    const where = (m: string) => configRefusal(`${file}: ${m}`, dir)?.where
    expect(where('tasks.test.outputs is required when `cache` is set')).toBe('config/tasks.ts:1:14')
    // A call's argument is not followed into the function: no frame, and
    // never one in the code past the function's own statement.
    expect(where('tasks.mk.exec has unknown field "comand"')).toBe('packages/b/more/vx.config.ts')
  })

  it('frames a missing named export at the import that names it', () => {
    const file = path.join(dir, 'packages', 'a', 'vx.config.ts')
    const tasks = path.join(dir, 'config', 'tasks.ts')
    expect(
      configRefusal(
        `Project config ${file}: an import names an export its module lacks: Export named 'testTask' not found in module '${tasks}'`,
        dir,
      ),
    ).toMatchObject({
      where: 'packages/a/vx.config.ts:2:10',
      problem: `an import names an export its module lacks: Export named 'testTask' not found in module 'config/tasks.ts'`,
    })
  })

  it('says a refusal it cannot frame at a relative path, with its fix', () => {
    const file = path.join(dir, 'packages', 'a', 'vx.config.ts')
    expect(
      configRefusal(
        `${file}: tasks.gone.outputs has unknown field "file" (allowed: clean, files) — did you mean files?`,
        dir,
      ),
    ).toEqual({
      where: 'packages/a/vx.config.ts',
      problem: 'tasks.gone.outputs has unknown field "file"',
      allowed: 'clean, files',
      fix: 'use files',
      frame: '',
    })
  })
})

describe('configRefusal', () => {
  it('splits a refusal in a directory whose name holds a space', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-frame-'))
    try {
      await mkdir(path.join(dir, 'my app'))
      const file = path.join(dir, 'my app', 'vx.config.ts')
      await writeFile(file, CONFIG)
      expect(
        configRefusal(
          `${file}: tasks.lint.fix.exec has unknown field "comand" (allowed: command, env) — did you mean command?`,
          dir,
        ),
      ).toEqual({
        where: 'my app/vx.config.ts:7:15',
        problem: 'tasks.lint.fix.exec has unknown field "comand"',
        allowed: 'command, env',
        fix: 'use command',
        frame:
          '  5 |     },\n' +
          "  6 |     'lint.fix': {\n" +
          "> 7 |       exec: { comand: 'x', timeout: -1 },\n" +
          '    |               ^',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('a dependsOn entry to remove is the fix', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-frame-'))
    try {
      const file = path.join(dir, 'vx.config.ts')
      await writeFile(
        file,
        "export default {\n  tasks: {\n    compile: { dependsOn: ['d#compile', 'd2#compile'] },\n  },\n}\n",
      )
      expect(
        configRefusal(
          `${file}: tasks.compile.dependsOn names d2#compile, but no project is named d2 — remove d2#compile from dependsOn`,
          dir,
        ),
      ).toMatchObject({
        problem: 'tasks.compile.dependsOn names d2#compile, but no project is named d2',
        fix: 'remove d2#compile from dependsOn',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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

  // A glob refusal quotes the glob raw, so one holding a backslash is no
  // JSON string: the frame's parse threw "JSON Parse error" and vx lock
  // crashed in place of the refusal.
  it('a glob refusal quoting a backslash, framed at its field', async () => {
    for (const glob of ['app/\\[id\\]/**.ts', 'src/{b}.ts', 'src/@(a|b).ts', 'src/(a|b).ts']) {
      const root = await realpath(await makeWorkspace({ prefix: 'vx-frame-glob-' }))
      try {
        const pkg = path.join(root, 'packages', 'b')
        await mkdir(pkg, { recursive: true })
        await writeFile(
          path.join(pkg, 'vx.config.mjs'),
          `export default {\n  tasks: {\n    build: {\n      exec: { command: 'true' },\n` +
            `      inputs: { files: [${JSON.stringify(glob)}] },\n    },\n  },\n}\n`,
        )
        const r = Bun.spawnSync(['bun', BIN, 'lock'], {
          cwd: root,
          env: { ...process.env, NO_COLOR: '1' },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const err = r.stderr.toString()
        expect([glob, r.exitCode, err.includes('JSON Parse')]).toEqual([glob, 1, false])
        expect(err).toStartWith(
          '✗ vx lock  lock not written\n\n  packages/b/vx.config.mjs:5:17\n  tasks.build.inputs.files: ',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
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

  // A config's own throw named its file by absolute path and showed no
  // line, though its stack placed it.
  it('a config that throws, at the line it threw from', async () => {
    const root = await realpath(await makeWorkspace({ prefix: 'vx-frame-throw-' }))
    try {
      const pkg = path.join(root, 'packages', 'b')
      await mkdir(pkg, { recursive: true })
      await writeFile(
        path.join(pkg, 'vx.config.mjs'),
        "const port = 1\nif (port) throw new Error('boom', { cause: new Error('deeper') })\nexport default { tasks: {} }\n",
      )
      const r = Bun.spawnSync(['bun', BIN, 'lock'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode).toBe(1)
      const err = r.stderr.toString()
      expect(err).toStartWith('✗ vx lock  lock not written\n\n  packages/b/vx.config.mjs:2:')
      expect(err).toContain('threw: boom; caused by: deeper (at packages/b/vx.config.mjs:2:')
      expect(err).toContain("  > 2 | if (port) throw new Error('boom'")
      expect(err).not.toContain(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A typo in a file three configs import was printed three times, each
  // framed at the config's own `test: testTask`; from a workspace package
  // preset, at an absolute path with no frame and `fix  files`.
  it('a field set in a shared file, framed there once with the configs it reaches', async () => {
    const root = await realpath(await makeWorkspace({ prefix: 'vx-frame-shared-' }))
    try {
      await mkdir(path.join(root, 'config'), { recursive: true })
      await writeFile(
        path.join(root, 'config', 'tasks.mjs'),
        "export const testTask = {\n  exec: { command: 'x' },\n  input: { files: [] },\n}\n",
      )
      for (const name of ['a', 'b', 'c']) {
        const pkg = path.join(root, 'packages', name)
        await mkdir(pkg, { recursive: true })
        await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
        await writeFile(
          path.join(pkg, 'vx.config.mjs'),
          "import { testTask } from '../../config/tasks.mjs'\nexport default { tasks: { test: testTask } }\n",
        )
      }
      const run = () =>
        Bun.spawnSync(['bun', BIN, 'lock'], {
          cwd: root,
          env: { ...process.env, NO_COLOR: '1' },
          stdout: 'pipe',
          stderr: 'pipe',
        })
      let r = run()
      expect(r.exitCode).toBe(1)
      let err = r.stderr.toString()
      expect(err).toStartWith(
        '✗ vx lock  lock not written\n\n  config/tasks.mjs:3:3\n  tasks.test has unknown field "input"\n' +
          '  used by packages/a/vx.config.mjs, packages/b/vx.config.mjs, packages/c/vx.config.mjs\n',
      )
      expect(err).toContain('  > 3 |   input: { files: [] },\n')
      expect(err).toContain('  fix  use inputs')
      expect(err).not.toContain('also refused')

      // A workspace package's preset, reached through its node_modules link.
      const presets = path.join(root, 'packages', 'presets')
      await mkdir(presets, { recursive: true })
      await writeFile(
        path.join(presets, 'package.json'),
        JSON.stringify({ name: '@ws/presets', version: '0.0.0', exports: './index.mjs' }),
      )
      await writeFile(
        path.join(presets, 'index.mjs'),
        "export const lib = () => ({\n  build: { exec: { command: 'x' }, outputs: { file: [] } },\n})\n",
      )
      await mkdir(path.join(root, 'node_modules', '@ws'), { recursive: true })
      await symlink(presets, path.join(root, 'node_modules', '@ws', 'presets'))
      await writeFile(
        path.join(root, 'config', 'tasks.mjs'),
        "export const testTask = { exec: { command: 'x' } }\n",
      )
      await writeFile(
        path.join(root, 'packages', 'a', 'vx.config.mjs'),
        "import { lib } from '@ws/presets'\nexport default { tasks: { ...lib() } }\n",
      )
      r = run()
      err = r.stderr.toString()
      expect(err).toStartWith(
        '✗ vx lock  lock not written\n\n  packages/presets/index.mjs:2:47\n' +
          '  tasks.build.outputs has unknown field "file"\n  used by packages/a/vx.config.mjs\n',
      )
      expect(err).toContain('  fix  use files')
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
        '✗ vx lock  lock not written\n\n  packages/a/vx.config.mjs:1:60\n  tasks.build.outputs must be an object (fields: clean, files, workspaceFiles), not an array',
      )
      expect(err).toContain('  fix  use `{ files: [...] }`')
      expect(err.match(/^✗ vx lock {2}also refused$/gm)).toHaveLength(4)
      for (const name of ['b', 'c', 'd', 'e'])
        expect(err).toContain(`packages/${name}/vx.config.mjs:1:60`)
      expect(err).toContain('✗ vx lock  2 more configs refused; fix these, then run vx lock again')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
