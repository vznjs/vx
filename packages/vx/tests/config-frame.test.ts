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
})

describe('vx prints a config refusal with its frame', () => {
  it('on stderr, under the one line it printed before', async () => {
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
      const r = Bun.spawnSync(['bun', BIN, 'run', 'build', '--all'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(r.exitCode).toBe(1)
      const err = r.stderr.toString()
      expect(err.split('\n')[0]).toStartWith(
        'vx: packages/b/vx.config.mjs:7:15: tasks.lint.exec has unknown field "comand"',
      )
      expect(err).toContain(
        "> 7 |       exec: { comand: 'x', timeout: -1 },\n    |               ^\n",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
