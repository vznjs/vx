// A write glob with a file part in the task's own directory admits a file
// the task creates under it, as a directory grant (`gen/`, or `dist/**`)
// does. On Linux it was matched when the task started, so the new file
// was refused (conformance sandbox/file-glob-output-in-new-dir-passes):
// its directory is bound now, made first when missing.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const available = await sandboxAvailable('sandbox write-glob guide test')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

const task = (command: string, write: string, read = '.'): string =>
  `{ exec: { command: '${command}', sandbox: { allow: { read: ['${read}'], write: ['${write}'] } } } }`

describe.skipIf(!available || process.platform !== 'linux')(
  'a write grant and a file the task creates',
  () => {
    it('a file-part glob admits it, as a directory grant does', async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'vx-wglob-'))
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
      )
      await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
      const app = path.join(root, 'packages', 'app')
      await mkdir(app, { recursive: true })
      await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
      await mkdir(path.join(app, 'src'))
      await writeFile(path.join(app, 'src', 'a.txt'), 'a')
      await mkdir(path.join(app, 'logs'))
      await writeFile(path.join(app, 'logs', 'old.log'), 'o')
      await mkdir(path.join(app, 'pre', 'esm'), { recursive: true })
      await writeFile(path.join(app, 'pre', 'esm', 'x.js'), 'x')
      await writeFile(
        path.join(app, 'vx.config.mjs'),
        `export default { name: 'app', tasks: {
  filePart: ${task('mkdir -p gen/x && echo x > gen/x/a.ts', 'gen/**/*.ts')},
  dirSlash: ${task('mkdir -p gen/x && echo x > gen/x/a.ts', 'gen/')},
  dirGlob: ${task('mkdir -p dist && echo x > dist/a.js', 'dist/**')},
  rootGlob: ${task('echo x > index.js', '*.js', 'src/')},
  deepGlob: ${task('mkdir -p out/sub && echo x > out/sub/a.js', 'out/**/*.js', 'src/')},
  logGlob: ${task('cp src/a.txt logs/new.log', 'logs/*.log', 'src/')},
  readBack: ${task('echo y > pre/esm/new.js && cat pre/esm/new.js pre/esm/x.js && ls pre pre/esm', 'pre/**/*.js', 'src/')},
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
      // No read grant shows the project (`rootGlob`), a directory the glob
      // matches beneath is made (`deepGlob`), and `cp` opens its new file
      // without `O_CREAT` first, a miss that is the task's own (`logGlob`).
      // Reading back and listing what the glob covers, in a folder a past
      // run left, is the task's own output (`readBack`).
      const tasks = [
        'filePart',
        'dirSlash',
        'dirGlob',
        'rootGlob',
        'deepGlob',
        'logGlob',
        'readBack',
      ]
      expect(tasks.map((t) => [t, code(t)])).toEqual(tasks.map((t) => [t, 0]))
      // Seven sandboxed runs, each near a second on CI and more on a loaded shard.
    }, 60_000)
  },
)
