// A declared output directory that is now a symbolic link out of the
// project. The entry was saved while `dist` was a real directory; restoring
// it would write through the link, so the restore refuses — containment
// holds — but it refused as "internal error in app#build:
// ArchiveSecurityError: archive entry escapes destDir via a symlinked
// parent", on every run, since the link is no input and the key never moves
// (upstream survey, nx#37061). It is the user's tree, not the artifact, so
// it is a user error that names the link and where it leads. Replacing the
// link with a real directory is what nx#37061 reports as the bug: the link
// is the user's, and it stays.

import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

async function vx(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

describe('restoring into an output directory that links out of the project', () => {
  let root: string
  let outside: string
  beforeEach(async () => {
    // Canonical roots: the message names real paths.
    root = await realpath(await makeWorkspace({ prefix: 'vx-link-out-' }))
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-link-out-target-')))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it(
    'is refused by name, the link kept and nothing written through it',
    async () => {
      const appDir = await addProject(root, 'app', {
        files: { 'src/x.txt': 'x', '.gitignore': 'dist\n' },
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist && cat src/x.txt > dist/o.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)

      const dist = path.join(appDir, 'dist')
      await rm(dist, { recursive: true })
      await symlink(outside, dist)
      for (let i = 0; i < 2; i++) {
        const r = await vx(root, ['run', 'build', '--all'])
        expect(r.code).toBe(1)
        expect(r.out).not.toContain('internal error')
        expect(r.out).toContain(
          `[vx] app#build: ${dist} is a symbolic link to ${outside}, outside ${appDir} — ` +
            'a cache restore never writes through a link that leaves its directory. ' +
            'Remove the link and re-run (the restore puts a real directory there), ' +
            'or stop declaring outputs under it.',
        )
        expect(lstatSync(dist).isSymbolicLink()).toBe(true)
        expect(existsSync(path.join(outside, 'o.txt'))).toBe(false)
      }

      // CONTROL: a link that stays inside the project is written through.
      const inside = path.join(appDir, 'real-out')
      await mkdir(inside)
      await rm(dist)
      await symlink(inside, dist)
      const ok = await vx(root, ['run', 'build', '--all'])
      expect(ok.code).toBe(0)
      expect(await Bun.file(path.join(inside, 'o.txt')).text()).toBe('x')
      expect(lstatSync(dist).isSymbolicLink()).toBe(true)
    },
    TIMEOUT,
  )
})

// The same link with its target gone (upstream survey, item 745). A live
// link that stays inside the project is written through (the control
// above), but `mkdir -p` does not follow a dangling one, so the hit failed:
// "blocked by what is on disk (EEXIST: mkdir '<p>/dist') … a path the
// output globs do not cover" at the link itself — `dist/**` covers it —
// and, below the link, ENOENT reported as a corrupt artifact. A dangling
// link is the user's as a live one is: the restore creates the directory
// it names and writes through it, and the link stays. Containment is the
// resolved path's: one that dangles out of the project is refused as a
// live link out is.

/** One task writing `entry`, cached with `outputs` (`dist/**` by default). */
function buildWriting(
  entry: string,
  gitignore: string,
  outputs = 'dist/**',
): Parameters<typeof addProject>[2] {
  return {
    files: { 'src/x.txt': 'x', '.gitignore': gitignore },
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'mkdir -p ${path.dirname(entry)} && cat src/x.txt > ${entry}' },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: ['${outputs}'] } },
          },
        },
      }
    `,
  }
}

describe('restoring through a dangling link inside the project', () => {
  // A root reached through a link, macOS's /var -> /private/var shape: the
  // containment compares resolved paths, and a canonical root would never
  // see one side resolved and the other not.
  let real: string
  let root: string
  beforeEach(async () => {
    real = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-dangle-')))
    await mkdir(path.join(real, 'r'))
    await symlink(path.join(real, 'r'), path.join(real, 'l'))
    root = await makeWorkspace({ prefix: 'ws-', dir: path.join(real, 'l') })
  })
  afterEach(async () => {
    await rm(real, { recursive: true, force: true })
  })

  const complete: string[] = []
  const log: Logger = {
    status() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete(node, outcome) {
      complete.push(`${node.id} ${outcome.status}`)
    },
  }
  async function runBuild(): Promise<string[]> {
    complete.length = 0
    const r = await run({ cwd: root, tasks: ['build'], log })
    expect(r.ok).toBe(true)
    return [...complete].sort()
  }

  // After the save, `remove` goes and `links` ([path, target], in order)
  // are made; the restored bytes must be found at `lands`. A link the output
  // globs themselves cover is not one of these: the clean unlinks it (the
  // control below), so a link below the root is held under a glob that
  // names the file alone.
  const shapes: {
    name: string
    entry: string
    outputs?: string
    remove: string
    links: (app: string) => [string, string][]
    lands: string
  }[] = [
    {
      name: 'the output root',
      entry: 'dist/o.txt',
      remove: 'dist',
      links: () => [['dist', 'real-out']],
      lands: 'real-out/o.txt',
    },
    {
      name: 'a directory below the output root',
      entry: 'dist/sub/o.txt',
      outputs: 'dist/sub/o.txt',
      remove: 'dist/sub',
      links: () => [['dist/sub', '../real-sub']],
      lands: 'real-sub/o.txt',
    },
    {
      name: 'the output root, above a deeper entry',
      entry: 'dist/sub/o.txt',
      remove: 'dist',
      links: () => [['dist', 'real-out']],
      lands: 'real-out/sub/o.txt',
    },
    {
      name: 'a chain of links',
      entry: 'dist/o.txt',
      remove: 'dist',
      links: () => [
        ['hop', 'real-out'],
        ['dist', 'hop'],
      ],
      lands: 'real-out/o.txt',
    },
    {
      name: 'an absolute link through the linked root',
      entry: 'dist/o.txt',
      remove: 'dist',
      links: (app) => [['dist', path.join(app, 'real-out')]],
      lands: 'real-out/o.txt',
    },
  ]

  for (const shape of shapes) {
    it(
      `at ${shape.name}: the hit creates its target and writes through it`,
      async () => {
        const appDir = await addProject(
          root,
          'app',
          buildWriting(shape.entry, 'dist\nreal-*\nhop\n', shape.outputs),
        )
        expect(await runBuild()).toEqual(['app#build success'])
        await rm(path.join(appDir, shape.remove), { recursive: true })
        const links = shape.links(appDir)
        for (const [at, to] of links) await symlink(to, path.join(appDir, at))
        expect(existsSync(path.join(appDir, shape.lands))).toBe(false)

        expect(await runBuild()).toEqual(['app#build cache-hit'])
        expect(await readFile(path.join(appDir, shape.lands), 'utf8')).toBe('x')
        for (const [at] of links)
          expect(lstatSync(path.join(appDir, at)).isSymbolicLink()).toBe(true)
        // The link is live now: the next hit is an ordinary one.
        expect(await runBuild()).toEqual(['app#build cache-hit'])
        expect(await readFile(path.join(appDir, shape.entry), 'utf8')).toBe('x')
      },
      TIMEOUT,
    )
  }

  // The rows above restore in the tier ahead of the schedule (a key known
  // up front). A task whose key can move with its dependency's output is
  // probed in its own slot and restores there — the same extraction, held
  // on that path too.
  it(
    'probed in its own slot: the same',
    async () => {
      const appDir = await addProject(root, 'app', {
        files: { 'src/seed.txt': 'seed', '.gitignore': 'dist\nreal-out\n' },
        config: `
          export default {
            tasks: {
              codegen: {
                exec: { command: 'cp src/seed.txt generated.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['generated.txt'] } },
              },
              build: {
                dependsOn: ['codegen'],
                exec: { command: 'mkdir -p dist && cat generated.txt > dist/o.txt' },
                cache: { inputs: { files: ['generated.txt'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      expect(await runBuild()).toEqual(['app#build success', 'app#codegen success'])
      await rm(path.join(appDir, 'dist'), { recursive: true })
      await symlink('real-out', path.join(appDir, 'dist'))
      expect(await runBuild()).toEqual(['app#build cache-hit', 'app#codegen cache-hit'])
      expect(await readFile(path.join(appDir, 'real-out/o.txt'), 'utf8')).toBe('seed')
      expect(lstatSync(path.join(appDir, 'dist')).isSymbolicLink()).toBe(true)
    },
    TIMEOUT,
  )
})

describe('a dangling link that leads out of the project', () => {
  let root: string
  let outside: string
  beforeEach(async () => {
    // Canonical roots: the message names real paths.
    root = await realpath(await makeWorkspace({ prefix: 'vx-dangle-out-' }))
    outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-dangle-out-target-')))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  // `named` is the link the refusal names; every shape leads to `gone`, in
  // `outside` or (`relative`) beside the project.
  const shapes: {
    name: string
    entry: string
    outputs?: string
    remove: string
    links: (gone: string) => [string, string][]
    named: string
    relative?: true
  }[] = [
    {
      name: 'at the output root',
      entry: 'dist/o.txt',
      remove: 'dist',
      links: (gone) => [['dist', gone]],
      named: 'dist',
    },
    {
      name: 'below the output root',
      entry: 'dist/sub/o.txt',
      outputs: 'dist/sub/o.txt',
      remove: 'dist/sub',
      links: (gone) => [['dist/sub', gone]],
      named: 'dist/sub',
    },
    {
      name: 'at the output root, above a deeper entry',
      entry: 'dist/sub/o.txt',
      remove: 'dist',
      links: (gone) => [['dist', gone]],
      named: 'dist',
    },
    {
      name: 'as the last hop of a chain',
      entry: 'dist/o.txt',
      remove: 'dist',
      links: (gone) => [
        ['hop', gone],
        ['dist', 'hop'],
      ],
      named: 'dist',
    },
    {
      name: 'relatively, up out of the project',
      entry: 'dist/o.txt',
      remove: 'dist',
      links: () => [['dist', '../gone']],
      named: 'dist',
      relative: true,
    },
  ]

  for (const shape of shapes) {
    it(
      `${shape.name}: refused by name, nothing created through it`,
      async () => {
        const appDir = await addProject(
          root,
          'app',
          buildWriting(shape.entry, 'dist\nhop\n', shape.outputs),
        )
        expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)

        const gone = shape.relative
          ? path.join(path.dirname(appDir), 'gone')
          : path.join(outside, 'gone')
        await rm(path.join(appDir, shape.remove), { recursive: true })
        const links = shape.links(gone)
        for (const [at, to] of links) await symlink(to, path.join(appDir, at))
        const r = await vx(root, ['run', 'build', '--all'])
        expect(r.code).toBe(1)
        expect(r.out).not.toContain('internal error')
        expect(r.out).toContain(
          `[vx] app#build: ${path.join(appDir, shape.named)} is a symbolic link to ${gone}, outside ${appDir} — ` +
            'a cache restore never writes through a link that leaves its directory.',
        )
        for (const [at] of links)
          expect(lstatSync(path.join(appDir, at)).isSymbolicLink()).toBe(true)
        expect(existsSync(path.dirname(gone))).toBe(true)
        expect(existsSync(gone)).toBe(false)
      },
      TIMEOUT,
    )
  }

  // CONTROL, both ways: a link the output globs cover is an output like
  // any file — the clean unlinks it, never following it, and the restore
  // puts a real directory where it stood.
  it(
    'a link the output globs cover is unlinked by the clean, never written through',
    async () => {
      const appDir = await addProject(root, 'app', buildWriting('dist/sub/o.txt', 'dist\n'))
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      const sub = path.join(appDir, 'dist/sub')
      const gone = path.join(outside, 'gone')
      await rm(sub, { recursive: true })
      await symlink(gone, sub)
      expect(lstatSync(sub).isSymbolicLink()).toBe(true)
      const r = await vx(root, ['run', 'build', '--all'])
      expect(r.code).toBe(0)
      expect(lstatSync(sub).isDirectory()).toBe(true)
      expect(await readFile(path.join(sub, 'o.txt'), 'utf8')).toBe('x')
      expect(existsSync(outside)).toBe(true)
      expect(existsSync(gone)).toBe(false)
    },
    TIMEOUT,
  )

  it(
    'a cycle of links is refused by name',
    async () => {
      const appDir = await addProject(root, 'app', buildWriting('dist/o.txt', 'dist\n'))
      expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
      const dist = path.join(appDir, 'dist')
      await rm(dist, { recursive: true })
      await symlink('dist', dist)
      const r = await vx(root, ['run', 'build', '--all'])
      expect(r.code).toBe(1)
      expect(r.out).toContain(
        `[vx] app#build: ${dist} goes through a cycle of symbolic links (at ${dist}) — ` +
          'a cache restore cannot write through it. Remove the link and re-run.',
      )
    },
    TIMEOUT,
  )
})
