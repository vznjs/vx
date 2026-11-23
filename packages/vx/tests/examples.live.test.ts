// The stack starters under examples/ run the real tools: vite, vitest,
// oxlint and next. Each is copied to a fresh git repo and set up as
// its README says (`bun install`, then `vx lock`), with the @vzn packages
// linked to this checkout instead of fetched, then driven through a cold
// run, a warm one and an edit. Its own task, `test.bun.examples`: the
// install needs the npm registry, which a shard's sandbox does not grant.
import {
  cpSync,
  existsSync,
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
import { lastStatus } from './helpers/last-run.js'

const CORE = path.resolve(import.meta.dir, '..')
const PACKAGES = path.dirname(CORE)
const EXAMPLES = path.resolve(PACKAGES, '..', 'examples')
const BIN = path.join(CORE, 'src', 'bin.ts')
const roots: string[] = []
// Each fixture's own store, never the home's shared one.
const ENV = { ...process.env, VX_CACHE_DIR: '.vx/cache' }
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function sh(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync({ cmd, cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(' ')}: ${r.stdout.toString()}${r.stderr.toString()}`)
  return r.stdout.toString()
}

function commit(root: string): void {
  sh(['git', 'add', '-A'], root)
  sh(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'step'], root)
}

/** `examples/<name>` set up as its README says, the @vzn packages it names linked to this checkout. */
function fixture(name: string): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), `vx-example-${name}-`)))
  roots.push(root)
  cpSync(path.join(EXAMPLES, name), root, { recursive: true })
  const manifest = path.join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
    devDependencies: Record<string, string>
  }
  const linked = Object.keys(pkg.devDependencies).filter((d) => d.startsWith('@vzn/'))
  for (const d of linked) delete pkg.devDependencies[d]
  writeFileSync(manifest, JSON.stringify(pkg, null, 2))
  sh([process.execPath, 'install'], root)
  mkdirSync(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  for (const d of linked)
    symlinkSync(path.join(PACKAGES, d.slice('@vzn/'.length)), path.join(root, 'node_modules', d))
  sh(['git', 'init', '-q'], root)
  commit(root)
  sh([process.execPath, BIN, 'lock'], root)
  commit(root)
  return root
}

function run(
  root: string,
  tasks: string[],
): { exit: number; output: string; status: Record<string, string> } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', ...tasks, '--all'],
    cwd: root,
    env: ENV,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exit: r.exitCode,
    output: `${r.stdout.toString()}${r.stderr.toString()}`,
    status: lastStatus(root, ENV),
  }
}

/** Each task of `ids` at `status`. */
const all = (ids: string[], status: string) => Object.fromEntries(ids.map((id) => [id, status]))

describe('examples/vite', () => {
  const root = fixture('vite')
  const tasks = ['ui#build', 'ui#lint', 'ui#test', 'web#build', 'web#lint', 'web#test']

  it('builds, tests and lints cold, replays warm, and re-runs what an edit to ui reaches', () => {
    const cold = run(root, ['build', 'test', 'lint'])
    expect(cold.output).toContain('6 success')
    expect(cold.status).toEqual(all(tasks, 'success'))
    expect(readFileSync(path.join(root, 'apps/web/dist/index.html'), 'utf8')).toContain(
      '<h1 id="inbox">',
    )

    const warm = run(root, ['build', 'test', 'lint'])
    expect(warm.exit).toBe(0)
    expect(warm.status).toEqual(all(tasks, 'cache-hit'))

    const ui = path.join(root, 'packages/ui/src/index.ts')
    writeFileSync(
      ui,
      readFileSync(ui, 'utf8').replace('${label} (${count})', '${label} (${count})​'),
    )
    const edited = run(root, ['build', 'test', 'lint'])
    expect(edited.status).toEqual({
      'ui#build': 'success',
      'ui#lint': 'success',
      'ui#test': 'failed',
      // ui's build input reaches web's keys through `^build`.
      'web#build': 'success',
      'web#lint': 'cache-hit',
      'web#test': 'failed',
    })
  })
})

describe('examples/next', () => {
  const root = fixture('next')
  const tasks = ['format#lint', 'format#test', 'site#build', 'site#lint']

  it('builds the Next app cold, replays it warm, and rebuilds it when format changes', () => {
    const cold = run(root, ['build', 'test', 'lint'])
    expect(cold.output).toContain('4 success')
    expect(cold.status).toEqual(all(tasks, 'success'))

    rmSync(path.join(root, 'apps/site/.next'), { recursive: true })
    const warm = run(root, ['build', 'test', 'lint'])
    expect(warm.exit).toBe(0)
    expect(warm.status).toEqual(all(tasks, 'cache-hit'))
    // The hit restored the build, the server's manifest with it.
    expect(existsSync(path.join(root, 'apps/site/.next/BUILD_ID'))).toBe(true)

    writeFileSync(
      path.join(root, 'packages/format/src/index.js'),
      'export function price(cents) {\n  return `€${(cents / 100).toFixed(2)}`\n}\n// edited\n',
    )
    const edited = run(root, ['build', 'test', 'lint'])
    expect(edited.exit).toBe(0)
    expect(edited.status).toEqual({
      'format#lint': 'success',
      'format#test': 'success',
      // format has no build of its own: its default one is keyed on its files.
      'site#build': 'success',
      'site#lint': 'cache-hit',
    })
  })
})
