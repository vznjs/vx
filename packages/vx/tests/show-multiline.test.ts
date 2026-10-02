// `vx show` lays each field out as `label: value`; a command that spans
// lines (vx init's `vx_script` wrapper for a pre/post trio, a heredoc)
// printed its continuation lines at column 0, where they read as the
// next task's header.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'a() {\\n  echo one\\n}\\na', env: { define: { X: 'p\\nq' } } },
        dependsOn: ['^build'],
      },
    },
  }
`

describe('vx show — a multi-line value continues under its first line', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-show-ml-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
    const dir = path.join(root, 'packages', 'app')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
    await writeFile(path.join(dir, 'vx.config.mjs'), CONFIG)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'show <project>#<task> indents the continuation to the value column',
    async () => {
      const proc = Bun.spawn(['bun', BIN, 'show', 'app#build'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect({ code, err }).toEqual({ code: 0, err: '' })
      expect(out).toBe(
        [
          'app — packages/app',
          '',
          'build',
          '  command:    a() {',
          '                echo one',
          '              }',
          '              a',
          '  dependsOn:  ^build',
          '  env.define: X=p',
          '              q',
          '',
        ].join('\n'),
      )
    },
    TIMEOUT,
  )
})
