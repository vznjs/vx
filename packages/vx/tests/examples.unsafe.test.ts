// The starter under examples/ is what a README tells a new user to copy, so
// it must run: each example is copied to a fresh git repo, `@vzn/vx`
// linked to this checkout, and `vx run ci --all` driven through a cold run,
// a warm one and an edit. examples/ lives outside packages/vx, which a
// sandboxed shard cannot read — hence the unsafe suite.
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const CORE = path.resolve(import.meta.dir, '..')
const EXAMPLE = path.resolve(CORE, '..', '..', 'examples', 'basic')
const BIN = path.join(CORE, 'src', 'bin.ts')
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-example-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function git(...args: string[]): void {
  const r = Bun.spawnSync({
    cmd: ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    cwd: root,
    stdout: 'ignore',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
}

let n = 0
/** One `vx run ci --all`: its exit and each task's status, from --summarize. */
function run(): { exit: number; status: Record<string, string> } {
  const summary = path.join(root, '..', `${path.basename(root)}-${n++}.json`)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'ci', '--all', `--summarize=${summary}`],
    cwd: root,
    env: { ...process.env, CI: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const tasks = (
    JSON.parse(readFileSync(summary, 'utf8')) as {
      tasks: { id: string; status: string }[]
    }
  ).tasks
  rmSync(summary, { force: true })
  return { exit: r.exitCode, status: Object.fromEntries(tasks.map((t) => [t.id, t.status])) }
}

describe('examples/basic', () => {
  cpSync(EXAMPLE, root, { recursive: true })
  mkdirSync(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  symlinkSync(CORE, path.join(root, 'node_modules', '@vzn', 'vx'))
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')

  it('builds cold, replays warm, and re-runs what an edit reaches', () => {
    // `ci` is a group: it runs nothing, so the summary has no row for it.
    const tasks = ['app#build', 'app#test', 'lib#build']
    const cold = run()
    expect(cold.exit).toBe(0)
    expect(Object.keys(cold.status).sort()).toEqual(tasks)
    expect(cold.status['lib#build']).toBe('success')
    const warm = run()
    expect(warm.exit).toBe(0)
    expect(warm.status['lib#build']).toBe('cache-hit')
    expect(warm.status['app#test']).toBe('cache-hit')
    writeFileSync(path.join(root, 'packages/lib/src/greet.js'), 'const greet = (n) => `hi, ${n}`\n')
    const edited = run()
    expect(edited.exit).toBe(0)
    expect([
      edited.status['lib#build'],
      edited.status['app#build'],
      edited.status['app#test'],
    ]).toEqual(['success', 'success', 'success'])
  })
})
