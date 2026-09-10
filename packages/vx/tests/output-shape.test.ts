// A restore across an output-shape change: the cached entry holds `dist/out`
// as a directory while the tree has a file there, or the reverse, or a
// symlink. Turbo pins the sequential-restore case (restore.rs); vx's
// `cleanOutputs` + extract were only ever driven through adversarial symlink
// cases and same-shape trees. The v25 history says this area corrupts
// silently when it goes wrong, so the assertion is the exact tree after
// each hit, read fresh — never "the run was green".

import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT, summarized } from './helpers/parity.js'

// The shape of `dist/out` follows the one input file: `dir` writes a
// directory with a file inside, `file` a plain file, `link` a symlink to a
// file outside dist. Every shape has its own cache key.
const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'sh build.sh' },
        cache: { inputs: { files: ['shape.txt', 'build.sh'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

const BUILD_SH = `set -e
rm -rf dist
mkdir -p dist
case "$(cat shape.txt)" in
  dir) mkdir dist/out && echo inner > dist/out/inner.txt ;;
  file) echo flat > dist/out ;;
  link) ln -s ../target.txt dist/out ;;
esac
`

type Shape = 'dir' | 'file' | 'link'

// A symlinked output is captured as its target's bytes and restored as a
// regular file (the archive never materialises a link), so `link` reads
// as a file with the target's content whichever way it got there — the
// link the task wrote (an up-to-date hit keeps it) or the file a restore
// wrote. Both are read through.
async function shapeOf(dir: string): Promise<{ kind: 'dir' | 'file'; detail: string }> {
  const out = path.join(dir, 'dist', 'out')
  const st = await lstat(out)
  if (st.isDirectory()) {
    return { kind: 'dir', detail: await readFile(path.join(out, 'inner.txt'), 'utf8') }
  }
  return { kind: 'file', detail: await readFile(out, 'utf8') }
}

const EXPECTED: Record<Shape, { kind: 'dir' | 'file'; detail: string }> = {
  dir: { kind: 'dir', detail: 'inner\n' },
  file: { kind: 'file', detail: 'flat\n' },
  link: { kind: 'file', detail: 'target\n' },
}

describe('restore across an output-shape change (e2e)', () => {
  let root: string
  let dir: string
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-output-shape-' })
    dir = await addProject(root, 'app', {
      config: CONFIG,
      files: { 'target.txt': 'target\n', 'build.sh': BUILD_SH },
    })
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function build(shape: Shape, expectStatus: 'success' | 'cache-hit'): Promise<void> {
    await writeFile(path.join(dir, 'shape.txt'), shape)
    const r = await summarized(root, ['app#build'])
    if (r.code !== 0) console.log(`--- ${shape} exited ${r.code}\n${r.text}`)
    expect(r.code).toBe(0)
    expect(r.tasks.get('app#build')?.['status']).toBe(expectStatus)
    expect(await shapeOf(dir)).toEqual(EXPECTED[shape])
  }

  it(
    'every transition restores the cached shape exactly: dir ↔ file ↔ link, in both directions',
    async () => {
      // Three misses populate three entries, one per shape.
      await build('dir', 'success')
      await build('file', 'success')
      await build('link', 'success')
      // Every ordered pair of shapes is a restore over the other shape's tree.
      const order: Shape[] = ['dir', 'link', 'file', 'dir', 'file', 'link', 'dir']
      for (const shape of order) await build(shape, 'cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a stray of the other shape left on disk is replaced by the restore, never merged',
    async () => {
      // A directory where the `file` entry holds a file: the clean removes
      // what the globs cover and prunes the emptied directory, so the file
      // lands. Then a file where the `dir` entry needs a directory.
      await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      await Bun.write(path.join(dir, 'dist', 'out', 'stray.txt'), 'stray')
      await build('file', 'cache-hit')
      await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      await Bun.write(path.join(dir, 'dist', 'out'), 'stale-file')
      await build('dir', 'cache-hit')
    },
    TIMEOUT,
  )

  it(
    'a symlink to a directory, or a dangling one, fails the save loudly instead of caching nothing',
    async () => {
      await writeFile(path.join(dir, 'shape.txt'), 'dir-link')
      await rm(path.join(dir, 'dist'), { recursive: true, force: true })
      await mkdir(path.join(dir, 'dist'))
      // The task's own script would rebuild dist; a task that only links is
      // the shape under test, so the command becomes the link itself.
      await writeFile(
        path.join(dir, 'build.sh'),
        'rm -rf dist && mkdir dist && ln -s ../src-dir dist/out\n',
      )
      await mkdir(path.join(dir, 'src-dir'))
      // The task itself succeeded; the SAVE refuses, loudly, and stores
      // nothing — so the next run executes again instead of hitting an
      // entry that would restore to nothing.
      const r = await summarized(root, ['app#build'])
      expect(r.code).toBe(0)
      expect(r.text).toMatch(/output dist\/out is not a regular file/)
      const again = await summarized(root, ['app#build'])
      expect(again.tasks.get('app#build')?.['status']).toBe('success')

      await writeFile(
        path.join(dir, 'build.sh'),
        'rm -rf dist && mkdir dist && ln -s ../missing dist/out\n',
      )
      const dangling = await summarized(root, ['app#build'])
      expect(dangling.code).toBe(0)
      expect(dangling.text).toMatch(/output dist\/out is a dangling symlink/)
    },
    TIMEOUT,
  )
})
