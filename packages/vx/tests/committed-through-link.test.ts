// "vx never deletes a git-tracked file": a committed file reached through
// an untracked link at an output glob's head (`public -> static`, made by a
// setup script) was asked about as `public/logo.txt`, a path git never
// lists, and the clean before the miss deleted `static/logo.txt`.

import { existsSync, readdirSync, symlinkSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'
import { run } from './helpers/orchestrator.js'
import { gitIn } from './helpers/workspace.js'
import { relPosix } from '../src/util/index.js'

let f: Fixture
beforeEach(async () => {
  f = await makeWorkspace('vx-committed-link-')
})
afterEach(async () => {
  await rm(f.root, { recursive: true, force: true })
})

it(
  'the clean keeps a committed file reached through an untracked output link',
  async () => {
    const dir = await addProject(f.root, 'app', {
      files: { 'static/logo.txt': 'committed', 'src/a.txt': 'v1', '.gitignore': 'public\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'cp src/a.txt public/a.txt' },
        inputs: { files: ['src/**'] }, outputs: { files: ['public/**'] }, cache: true,
      } } }`,
    })
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    symlinkSync('static', path.join(dir, 'public'))
    const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(r.outcomes[0]?.status).toBe('success')
    expect(existsSync(path.join(dir, 'static/logo.txt'))).toBe(true)
    // The restore's clean takes the same path.
    await rm(path.join(dir, 'static/a.txt'))
    const hit = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(hit.outcomes[0]?.status).toBe('cache-hit')
    expect(existsSync(path.join(dir, 'static/logo.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'static/a.txt'))).toBe(true)
  },
  TIMEOUT,
)

// An output directory linked into the task's own input tree (`dist ->
// src`) made the target the output (X-88), so the clean before the run
// deleted every untracked source under it, with only a "changed after its
// key was taken" warning; committed, the link instead shielded every file
// past it as tracked. Both are X-55's self-clean, refused by name.
it.each([false, true])(
  'an output dir linked into its own inputs is refused, deleting nothing (committed link: %p)',
  async (commitLink) => {
    const dir = await addProject(f.root, 'app', {
      files: { 'src/a.txt': 'v1', '.gitignore': 'dist\nsrc/local.env\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'cp src/a.txt dist/a.out' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    symlinkSync('src', path.join(dir, 'dist'))
    const git = gitIn(f.root)
    git('add', '-A')
    if (commitLink) git('add', '-f', relPosix(f.root, path.join(dir, 'dist')))
    git('commit', '-q', '-m', 'init')
    await writeFile(path.join(dir, 'src/new.txt'), 'new work')
    await writeFile(path.join(dir, 'src/local.env'), 'ignored work')
    const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(r.outcomes[0]?.status).toBe('failed')
    expect(f.err.join('\n')).toContain(`${path.join(dir, 'dist')} is a symbolic link into`)
    expect(existsSync(path.join(dir, 'src/new.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'src/local.env'))).toBe(true)
    expect(existsSync(path.join(dir, 'src/a.out'))).toBe(false)
  },
  TIMEOUT,
)

it(
  "a hit's restore refuses an output dir since linked into its inputs, deleting nothing",
  async () => {
    const dir = await addProject(f.root, 'app', {
      files: { 'src/a.txt': 'v1', '.gitignore': 'dist\nsrc/local.env\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.out' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const miss = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(miss.outcomes[0]?.status).toBe('success')
    // An ignored file is no input: the key holds, so the next run is a hit.
    await rm(path.join(dir, 'dist'), { recursive: true })
    symlinkSync('src', path.join(dir, 'dist'))
    await writeFile(path.join(dir, 'src/local.env'), 'ignored work')
    const hit = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(hit.outcomes[0]?.status).toBe('failed')
    expect(f.err.join('\n')).toContain(`${path.join(dir, 'dist')} is a symbolic link into`)
    expect(existsSync(path.join(dir, 'src/local.env'))).toBe(true)
    expect(existsSync(path.join(dir, 'src/a.out'))).toBe(false)
  },
  TIMEOUT,
)

// The workspace twin: `outputs.workspaceFiles: ['packages/app/dist/**']` through
// `app/dist -> src` was walked with no inputs, so the clean deleted the
// untracked sources `inputs.files` or `inputs.workspaceFiles` read.
it.each(["files: ['src/**']", "files: [], workspaceFiles: ['packages/app/src/**']"])(
  'a workspace output dir linked into its own inputs is refused, deleting nothing (%s)',
  async (inputs) => {
    const dir = await addProject(f.root, 'app', {
      files: { 'src/a.txt': 'v1', '.gitignore': 'dist\nsrc/local.env\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'cp src/a.txt dist/a.out' },
        inputs: { ${inputs} }, outputs: { files: [], workspaceFiles: ['packages/app/dist/**'] }, cache: true,
      } } }`,
    })
    symlinkSync('src', path.join(dir, 'dist'))
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    await writeFile(path.join(dir, 'src/new.txt'), 'new work')
    await writeFile(path.join(dir, 'src/local.env'), 'ignored work')
    const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(r.outcomes[0]?.status).toBe('failed')
    expect(f.err.join('\n')).toContain(`${path.join(dir, 'dist')} is a symbolic link into`)
    expect(existsSync(path.join(dir, 'src/new.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'src/local.env'))).toBe(true)
    expect(existsSync(path.join(dir, 'src/a.out'))).toBe(false)
  },
  TIMEOUT,
)

it(
  "a hit's restore refuses a workspace output dir since linked into its inputs, deleting nothing",
  async () => {
    const dir = await addProject(f.root, 'app', {
      files: { 'src/a.txt': 'v1', '.gitignore': 'dist\nsrc/local.env\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && cp src/a.txt dist/a.out' },
        inputs: { files: [], workspaceFiles: ['packages/app/src/**'] }, outputs: { files: [], workspaceFiles: ['packages/app/dist/**'] },
        cache: true,
      } } }`,
    })
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const miss = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(miss.outcomes[0]?.status).toBe('success')
    await rm(path.join(dir, 'dist'), { recursive: true })
    symlinkSync('src', path.join(dir, 'dist'))
    await writeFile(path.join(dir, 'src/local.env'), 'ignored work')
    const hit = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(hit.outcomes[0]?.status).toBe('failed')
    expect(f.err.join('\n')).toContain(`${path.join(dir, 'dist')} is a symbolic link into`)
    expect(existsSync(path.join(dir, 'src/local.env'))).toBe(true)
    expect(existsSync(path.join(dir, 'src/a.out'))).toBe(false)
  },
  TIMEOUT,
)

// A project output linked into what `inputs.workspaceFiles` alone reads.
it(
  'an output dir linked into its own workspace inputs is refused, deleting nothing',
  async () => {
    const dir = await addProject(f.root, 'app', {
      files: { 'src/a.txt': 'v1', '.gitignore': 'dist\nsrc/local.env\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'cp src/a.txt dist/a.out' },
        inputs: { files: [], workspaceFiles: ['packages/app/src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    symlinkSync('src', path.join(dir, 'dist'))
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    await writeFile(path.join(dir, 'src/new.txt'), 'new work')
    const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(r.outcomes[0]?.status).toBe('failed')
    expect(f.err.join('\n')).toContain(`${path.join(dir, 'dist')} is a symbolic link into`)
    expect(existsSync(path.join(dir, 'src/new.txt'))).toBe(true)
  },
  TIMEOUT,
)

// A glob with no fixed prefix, or one rooted above the link's target,
// reaches below it too: `**/*.txt` read `src/new.txt`, yet only a glob
// whose prefix sat inside the target was asked, so the clean deleted it.
it.each([
  ["'**/*.txt'", 'src'],
  ["'**'", 'src'],
  ["'*/new.txt'", 'src'],
  ["'src/**'", 'src/lib'],
  ["'src/*/new.txt'", 'src/lib'],
])(
  'an output dir linked under what %s reads (dist -> %s) is refused, deleting nothing',
  async (glob, target) => {
    const dir = await addProject(f.root, 'app', {
      files: { 'src/lib/a.txt': 'v1', '.gitignore': 'dist\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'cp src/lib/a.txt dist/a.out' },
        inputs: { files: [${glob}] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    symlinkSync(target, path.join(dir, 'dist'))
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    await writeFile(path.join(dir, target, 'new.txt'), 'new work')
    const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(existsSync(path.join(dir, target, 'new.txt'))).toBe(true)
    expect(r.outcomes[0]?.status).toBe('failed')
    expect(f.err.join('\n')).toContain(`${path.join(dir, 'dist')} is a symbolic link into`)
  },
  TIMEOUT,
)

// A link to a sibling no input glob reaches stays an output directory
// (X-88): the target is cleaned and holds the run's files.
it.each(["'src/**'", "'*.json'", "'src/*/a.txt'", "'{src,lib}/**'"])(
  'an output dir linked to a sibling %s cannot reach is still an output',
  async (glob) => {
    const dir = await addProject(f.root, 'app', {
      files: {
        'src/a.txt': 'v1',
        'build-out/stale.out': 'old',
        'a.json': '{}',
        '.gitignore': 'dist\nbuild-out\n',
      },
      config: `export default { tasks: { build: {
        exec: { command: 'cp src/a.txt dist/a.out' },
        inputs: { files: [${glob}] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    symlinkSync('build-out', path.join(dir, 'dist'))
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
    expect(r.outcomes[0]?.status).toBe('success')
    expect(existsSync(path.join(dir, 'build-out/a.out'))).toBe(true)
    expect(existsSync(path.join(dir, 'build-out/stale.out'))).toBe(false)
  },
  TIMEOUT,
)

// git tracks no file through a symlink, so a committed `dist -> real` link
// covers nothing under it. Asked as an ancestor, it made every file past
// it committed: no clean deleted one, each miss saved the files of every
// earlier run, and a hit brought them back.
it(
  'a committed output link shields no file past it from the clean',
  async () => {
    const dir = await addProject(f.root, 'app', {
      files: { 'src/a.txt': 'b', 'real/keep.txt': 'committed' },
      config: `export default { tasks: { build: {
        exec: { command: 'cp src/a.txt dist/a.out && touch dist/f$(cat src/a.txt)' },
        inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
      } } }`,
    })
    symlinkSync('real', path.join(dir, 'dist'))
    const git = gitIn(f.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const build = async (src: string, status: 'success' | 'cache-hit'): Promise<string[]> => {
      await writeFile(path.join(dir, 'src/a.txt'), src)
      const r = await run({ cwd: f.root, tasks: ['build'], log: silentLogger(f) })
      expect(r.outcomes[0]?.status).toBe(status)
      return readdirSync(path.join(dir, 'real')).sort()
    }
    expect(await build('b', 'success')).toEqual(['a.out', 'fb', 'keep.txt'])
    expect(await build('c', 'success')).toEqual(['a.out', 'fc', 'keep.txt'])
    // The restore's clean, on its own: a file no entry holds is gone.
    await writeFile(path.join(dir, 'real/stray'), 'old run')
    expect(await build('b', 'cache-hit')).toEqual(['a.out', 'fb', 'keep.txt'])
  },
  TIMEOUT,
)
