// A `^lint` edge the graph passes through a loaded project that declares no
// `lint` (`mid`) folds only the holders past it (`lib#lint`) into the key.
// `--affected` seeded the task on any change in the passed-through project,
// so an edit to `mid` ran `app#lint`, whose key had not moved. The selection
// must follow the key both ways: an edit to `lib` still selects it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { edgesSource } from './helpers/plugin.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      ...args,
    ],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

const LINT = `exec: { command: 'true' }, cache: true, inputs: { files: ['src/**'] }, outputs: { files: [] }`

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-pass-'))
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await write(
    path.join(root, '.vx/workspace.mjs'),
    localWorkspaceSource([edgesSource({ app: ['mid'], mid: ['lib'] })]),
  )
  const tasks: Record<string, string> = {
    app: `lint: { dependsOn: ['^lint'], ${LINT} }`,
    mid: `t: { exec: { command: 'true' } }`,
    lib: `lint: { ${LINT} }`,
  }
  for (const [p, t] of Object.entries(tasks)) {
    await write(path.join(root, `pkgs/${p}/package.json`), JSON.stringify({ name: p }))
    await write(path.join(root, `pkgs/${p}/src/a.ts`), 'x\n')
    await write(path.join(root, `pkgs/${p}/vx.config.mjs`), `export default { tasks: { ${t} } }\n`)
  }
  await write(path.join(root, '.gitignore'), '.vx/cache/\n')
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The `--dry=json` plan of `vx run lint <args>`: each task id and its key. */
function plan(...args: string[]): Map<string, string> {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, 'run', 'lint', ...args, '--dry=json'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  const out = p.stdout.toString()
  if (p.exitCode !== 0) throw new Error(out + p.stderr.toString())
  if (!out.includes('{')) return new Map()
  const json = JSON.parse(out.slice(out.indexOf('{'))) as {
    tasks?: { id: string; hash: string }[]
  }
  return new Map((json.tasks ?? []).map((t) => [t.id, t.hash]))
}

/** After an edit to `rel`: did app#lint's key move, and did `--affected` select it? */
async function afterEdit(rel: string): Promise<{ moved: boolean; selected: boolean }> {
  const before = plan('--all').get('app#lint')
  if (before === undefined) throw new Error('app#lint is not planned')
  await write(path.join(root, rel), 'y\n')
  git(root, 'commit', '-qam', `edit ${rel}`)
  return {
    moved: plan('--all').get('app#lint') !== before,
    selected: plan('--affected=HEAD~1').has('app#lint'),
  }
}

describe('--affected through a passed-through ^name', () => {
  it(
    'an edit to the passed-through project moves no key and selects nothing',
    async () => {
      expect(await afterEdit('pkgs/mid/src/a.ts')).toEqual({ moved: false, selected: false })
    },
    TIMEOUT,
  )

  it(
    'an edit to the holder past it moves the key and selects the task',
    async () => {
      expect(await afterEdit('pkgs/lib/src/a.ts')).toEqual({ moved: true, selected: true })
    },
    TIMEOUT,
  )
})
