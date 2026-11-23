// A `--force` run replaces the entry its key held. The local store kept the
// first entry saved under a key and dropped the forced run's bytes, so a
// task whose bytes vary (a counter, a timestamp) or an entry the user
// doubted came back on the next plain run: `--force` could not repair it.
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root = ''
const vx = (...args: string[]): string => {
  const p = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: path.join(root, 'packages/app'),
    env: { ...process.env, NO_COLOR: '1', CI: '' },
  })
  if (p.exitCode !== 0) throw new Error(`vx ${args.join(' ')}: ${p.stderr.toString()}${p.stdout.toString()}`)
  return p.stdout.toString()
}
const out = (): Promise<string> => readFile(path.join(root, 'packages/app/dist/n.txt'), 'utf8')

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-force-replaces-' })
  await addProject(root, 'app', {
    config: `export default { tasks: { build: {
      exec: { command: 'mkdir -p dist && n=$(cat ../../count 2>/dev/null || echo 0) && n=$((n+1)) && echo $n > ../../count && echo $n > dist/n.txt' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    } } }\n`,
    files: { 'src/a.txt': 'a\n', '.gitignore': 'dist/\n' },
  })
  vx('lock')
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('the next plain run replays what the forced run wrote', async () => {
  vx('run', 'build')
  expect(await out()).toBe('1\n')
  vx('run', 'build', '--force')
  expect(await out()).toBe('2\n')
  await rm(path.join(root, 'packages/app/dist'), { recursive: true })
  vx('run', 'build')
  expect(await out()).toBe('2\n')
}, 30_000)
