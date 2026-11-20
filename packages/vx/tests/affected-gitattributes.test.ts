// `--affected` after a `.gitattributes` change (vercel/turborepo#15004).
//
// A line-ending rule changes the bytes a checkout writes for files git still
// stores as the same blobs: on a fresh clone at HEAD the task reads CRLF where
// the base wrote LF, so its key moves. The changed path is the attributes
// file alone, which no task names as an input, so selection must widen to
// every project under the file's directory.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${p.exitCode}: ${p.stderr.toString().trim()}`)
  }
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

function affected(cwd: string): string {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, 'run', 'build', '--affected=HEAD~1', '--dry'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  const out = p.stdout.toString() + p.stderr.toString()
  expect(p.exitCode, out).toBe(0)
  return out
}

let root: string

const project = (name: string): string =>
  [
    'export default {',
    '  tasks: {',
    '    build: {',
    `      exec: { command: "od -c src/a.txt > out.txt" },`,
    '      inputs: { files: ["src/**"] },',
    '      outputs: { files: ["out.txt"] },',
    '      cache: true,',
    '    },',
    '  },',
    '}',
    `// ${name}`,
    '',
  ].join('\n')

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-affected-attrs-'))
  await write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await writeLocalWorkspace(root)
  for (const name of ['app', 'lib']) {
    await write(path.join(root, `pkgs/${name}/package.json`), JSON.stringify({ name }))
    await write(path.join(root, `pkgs/${name}/src/a.txt`), `${name}\n`)
    await write(path.join(root, `pkgs/${name}/vx.config.mjs`), project(name))
  }
  await write(path.join(root, 'tools/.keep'), '')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 't@vx.local')
  git(root, 'config', 'user.name', 'vx')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'initial')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function commitRule(at: string): Promise<void> {
  await write(path.join(root, at, '.gitattributes'), '*.txt text eol=crlf\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', `eol rule in ${at}`)
}

it(
  'a root rule selects every project, whose clone reads new bytes',
  async () => {
    await commitRule('.')
    const clone = `${root}-clone`
    git(os.tmpdir(), 'clone', '-q', root, clone)
    try {
      expect(await readFile(path.join(clone, 'pkgs/app/src/a.txt'), 'utf8')).toBe('app\r\n')
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
    const out = affected(root)
    expect(out).toContain('app#build')
    expect(out).toContain('lib#build')
  },
  TIMEOUT,
)

it(
  'a rule in a directory above projects selects the projects under it',
  async () => {
    await mkdir(path.join(root, 'pkgs'), { recursive: true })
    await commitRule('pkgs')
    const out = affected(root)
    expect(out).toContain('app#build')
    expect(out).toContain('lib#build')
  },
  TIMEOUT,
)

it(
  "a project's own rule selects its tasks, though none names it as an input",
  async () => {
    await commitRule('pkgs/app')
    const out = affected(root)
    expect(out).toContain('app#build')
    expect(out).not.toContain('lib#build')
  },
  TIMEOUT,
)

it(
  'a rule in a directory holding no project selects nothing',
  async () => {
    await commitRule('tools')
    const out = affected(root)
    expect(out).not.toContain('app#build')
    expect(out).not.toContain('lib#build')
  },
  TIMEOUT,
)
