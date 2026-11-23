// `--affected` after a `.gitattributes` change (vercel/turborepo#15004).
//
// A line-ending rule changes the bytes a checkout writes for files git still
// stores as the same blobs: on a fresh clone at HEAD the task reads CRLF where
// the base wrote LF, so its key moves. The changed path is the attributes
// file alone, which no task names as an input, so selection must widen to
// every project under the file's directory.

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import { git, gitInit } from './helpers/workspace.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')

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
  await Bun.write(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'r', workspaces: ['pkgs/*'] }),
  )
  await writeLocalWorkspace(root)
  for (const name of ['app', 'lib']) {
    await Bun.write(path.join(root, `pkgs/${name}/package.json`), JSON.stringify({ name }))
    await Bun.write(path.join(root, `pkgs/${name}/src/a.txt`), `${name}\n`)
    await Bun.write(path.join(root, `pkgs/${name}/vx.config.mjs`), project(name))
  }
  await Bun.write(path.join(root, 'tools/.keep'), '')
  gitInit(root)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'initial')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function commitRule(at: string): Promise<void> {
  await Bun.write(path.join(root, at, '.gitattributes'), '*.txt text eol=crlf\n')
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

async function commitAttributes(text: string, message: string): Promise<void> {
  await Bun.write(path.join(root, '.gitattributes'), text)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', message)
}

it(
  'a rule that moves no checked-out byte selects nothing',
  async () => {
    // `linguist-generated -diff` shapes GitHub's view and `git diff`, never a
    // checkout: every project was selected (conformance growth).
    await commitAttributes('*.txt linguist-generated -diff\n', 'view-only rule')
    const out = affected(root)
    expect(out).not.toContain('app#build')
    expect(out).not.toContain('lib#build')
  },
  TIMEOUT,
)

it(
  'a view-only attribute added beside a checkout rule selects nothing; reordered checkout rules select all',
  async () => {
    await commitAttributes('*.txt text eol=lf\n*.txt -text\n', 'checkout rules')
    await commitAttributes('*.txt text eol=lf -diff\n# note\n*.txt -text\n', 'view-only edit')
    let out = affected(root)
    expect(out).not.toContain('app#build')
    // The later line wins: swapped, the checkout writes other bytes.
    await commitAttributes('*.txt -text\n*.txt text eol=lf -diff\n', 'swap')
    out = affected(root)
    expect(out).toContain('app#build')
    expect(out).toContain('lib#build')
  },
  TIMEOUT,
)

it(
  'a view-only rule above projects selects nothing under it',
  async () => {
    await Bun.write(path.join(root, 'pkgs/.gitattributes'), '*.txt linguist-vendored\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'nested view-only')
    const out = affected(root)
    expect(out).not.toContain('app#build')
    expect(out).not.toContain('lib#build')
  },
  TIMEOUT,
)
