// The sandboxing guide: on Linux a write glob with a file part is matched
// when the task starts, so a file the task creates under it is refused,
// while a directory grant (`gen/`, or `dist/**`) admits it. The guide
// said so twice; this pins the claim it now makes once.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const available = await sandboxAvailable('sandbox write-glob guide test')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const task = (command: string, write: string): string =>
  `{ exec: { command: '${command}', sandbox: { allow: { read: ['.'], write: ['${write}'] } } } }`

describe.skipIf(!available || process.platform !== 'linux')(
  'a write grant and a file the task creates',
  () => {
    it('a file-part glob refuses it; a directory grant admits it', async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'vx-wglob-'))
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
      )
      const app = path.join(root, 'packages', 'app')
      await mkdir(app, { recursive: true })
      await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        `export default { tasks: {
  filePart: ${task('mkdir -p gen/x && echo x > gen/x/a.ts', 'gen/**/*.ts')},
  dirSlash: ${task('mkdir -p gen/x && echo x > gen/x/a.ts', 'gen/')},
  dirGlob: ${task('mkdir -p dist && echo x > dist/a.js', 'dist/**')},
} }
`,
      )
      expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
      const code = (t: string): number | null =>
        Bun.spawnSync({
          cmd: [process.execPath, BIN, 'run', `app#${t}`],
          cwd: root!,
          stdout: 'pipe',
          stderr: 'pipe',
        }).exitCode
      expect(['filePart', 'dirSlash', 'dirGlob'].map((t) => [t, code(t)])).toEqual([
        ['filePart', 1],
        ['dirSlash', 0],
        ['dirGlob', 0],
      ])
    })
  },
)
