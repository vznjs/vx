// A restore across an output-shape change: the cached entry holds `dist/out`
// as a directory while the tree has a file there, or the reverse, or a
// symlink. Turbo pins the sequential-restore case (restore.rs); vx's
// `cleanOutputs` + extract were only ever driven through adversarial symlink
// cases and same-shape trees. The v25 history says this area corrupts
// silently when it goes wrong, so the assertion is the exact tree after
// each hit, read fresh — never "the run was green".

import { lstatSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { storedBytesUnder } from './helpers/stored-artifact.js'
import { PARITY_TIMEOUT as TIMEOUT, summarized } from './helpers/parity.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

// The shape of `dist/out` follows the one input file: `dir` writes a
// directory with a file inside, `file` a plain file, `link` a symlink to a
// file outside dist. Every shape has its own cache key.
const CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'sh build.sh' },
        inputs: { files: ['shape.txt', 'build.sh'] }, cache: { outputs: { files: ['dist/**'] } },
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

// A symlinked output is cached and restored as the link, so `link` reads
// through to the target's content.
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
    'a symlink to a directory, or a dangling one, is cached and comes back as the link',
    async () => {
      await writeFile(path.join(dir, 'shape.txt'), 'dir-link')
      await mkdir(path.join(dir, 'src-dir'))
      for (const to of ['../src-dir', '../missing']) {
        await writeFile(
          path.join(dir, 'build.sh'),
          `rm -rf dist && mkdir dist && ln -s ${to} dist/out\n`,
        )
        const r = await summarized(root, ['app#build'])
        expect(r.code).toBe(0)
        expect(r.tasks.get('app#build')?.['status']).toBe('success')
        await rm(path.join(dir, 'dist'), { recursive: true, force: true })
        const hit = await summarized(root, ['app#build'])
        expect(hit.tasks.get('app#build')?.['status']).toBe('cache-hit')
        expect(await readlink(path.join(dir, 'dist', 'out'))).toBe(to)
      }
    },
    TIMEOUT,
  )
})

// turborepo#13042: an output directory that is itself a symlink (`dist ->
// real-out`, both inside the package) cached nothing.
describe('an output directory that is a symlink inside the project (e2e)', () => {
  it(
    'saves through the link, hits, and a hit restores the file the link leads to',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-output-linkdir-' })
      try {
        const dir = await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'mkdir -p real-out && ln -sfn real-out dist && cat src/in.txt > dist/out.js' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
                },
              },
            }
          `,
          files: { 'src/in.txt': 'v1\n' },
        })
        const status = async () => (await summarized(root, ['app#build'])).tasks.get('app#build')
        expect((await status())?.['status']).toBe('success')
        expect((await status())?.['status']).toBe('cache-hit')

        await rm(path.join(dir, 'real-out', 'out.js'))
        expect((await status())?.['status']).toBe('cache-hit')
        expect(await readFile(path.join(dir, 'dist', 'out.js'), 'utf8')).toBe('v1\n')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    "each entry holds only its own run's files, and a hit leaves no other entry's (X-88)",
    async () => {
      // The clean skipped files reached through the link (X-5) while the
      // save followed it: the entry for `two` held `one.js` too, and a hit
      // for `one` left `two.js` beside it.
      const root = await makeWorkspace({ prefix: 'vx-output-linkdir-clean-' })
      try {
        const dir = await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'mkdir -p real-out && ln -sfn real-out dist && cat src/s.txt > dist/$(cat src/s.txt).js' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
                },
              },
            }
          `,
          files: { 'src/s.txt': 'one' },
        })
        const build = async (state: string, status: string): Promise<string[]> => {
          await writeFile(path.join(dir, 'src', 's.txt'), state)
          const r = await summarized(root, ['app#build'])
          expect(r.tasks.get('app#build')?.['status']).toBe(status)
          return (await readdir(path.join(dir, 'real-out'))).sort()
        }
        expect(await build('one', 'success')).toEqual(['one.js'])
        expect(await build('two', 'success')).toEqual(['two.js'])
        expect(await build('one', 'cache-hit')).toEqual(['one.js'])
        expect(await build('two', 'cache-hit')).toEqual(['two.js'])
        expect(lstatSync(path.join(dir, 'dist')).isSymbolicLink()).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it.each([[['dist']], [['dist/', 'real-out/**']]])(
    'a literal output naming the link (%p) saves through it and hits',
    async (outputs: string[]) => {
      // A literal names the path and its tree: the save held `dist` as the
      // link and `dist/out.js` through it, refused it as a file and a
      // directory, and the task never cached.
      const root = await makeWorkspace({ prefix: 'vx-output-linkdir-literal-' })
      try {
        const dir = await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'mkdir -p real-out && ln -sfn real-out dist && cat src/in.txt > dist/out.js' },
                  inputs: { files: ['src/**'] }, cache: { outputs: { files: ${JSON.stringify(outputs)} } },
                },
              },
            }
          `,
          files: { 'src/in.txt': 'v1\n' },
        })
        const run = () => summarized(root, ['app#build'])
        const first = await run()
        expect([
          first.tasks.get('app#build')?.['status'],
          first.text.includes('save failed'),
        ]).toEqual(['success', false])
        expect((await run()).tasks.get('app#build')?.['status']).toBe('cache-hit')
        await rm(path.join(dir, 'real-out', 'out.js'))
        expect((await run()).tasks.get('app#build')?.['status']).toBe('cache-hit')
        expect(await readFile(path.join(dir, 'dist', 'out.js'), 'utf8')).toBe('v1\n')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// vx packs outputs outside the task's sandbox: following a link a task
// planted to a file it could not read (another project's) put that file's
// bytes in the artifact and the remote (L-23). A link is kept as the link,
// so the artifact holds its target's name and none of its bytes.
describe('a symlinked output that leaves the project (e2e)', () => {
  it(
    'is cached as the link and stores none of the target',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-output-linkout-' })
      try {
        await addProject(root, 'other', { files: { 'secret.txt': 'L23-SECRET\n' } })
        await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'rm -rf dist && mkdir dist && ln -s ../../other/secret.txt dist/out' },
                  inputs: { files: ['package.json'] }, cache: { outputs: { files: ['dist/**'] } },
                },
              },
            }
          `,
        })
        const r = await summarized(root, ['app#build'])
        expect([r.code, r.text.includes('cache save failed')]).toEqual([0, false])
        const held: string[] = []
        for (const [f, bytes] of storedBytesUnder(root)) {
          const tar = Bun.zstdDecompressSync(bytes)
          if (new TextDecoder().decode(tar).includes('L23-SECRET')) held.push(f)
        }
        expect(held).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// A root-anchored output tree is outside every project, so a link there to
// another file of the same tree (`gen/latest -> v2.txt`) was refused as
// leaving the project, and the task never cached (J's lead). A link out of
// the workspace is refused.
describe('a symlinked workspace output (e2e)', () => {
  const config = (link: string): string => `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p ../../gen && echo v2 > ../../gen/v2.txt && ln -sfn ${link} ../../gen/latest' },
          inputs: { files: ['package.json'] }, cache: { outputs: { files: [], workspaceFiles: ['gen/**'] } },
        },
      },
    }
  `

  it(
    'to another output of its own caches, and restores as the link',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-ws-output-link-' })
      try {
        await addProject(root, 'app', { config: config('v2.txt') })
        const r = await summarized(root, ['app#build'])
        expect([r.code, r.text.includes('cache save failed')]).toEqual([0, false])
        await rm(path.join(root, 'gen'), { recursive: true, force: true })
        const again = await summarized(root, ['app#build'])
        expect(again.tasks.get('app#build')?.['status']).toBe('cache-hit')
        expect(await readlink(path.join(root, 'gen', 'latest'))).toBe('v2.txt')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'out of the workspace is refused',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-ws-output-linkout-' })
      try {
        await addProject(root, 'app', { config: config('../../outside') })
        const r = await summarized(root, ['app#build'])
        expect(r.text).toContain(
          'workspaceFiles output gen/latest is a symlink to ../../outside, outside the workspace',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('a miss across an output-shape change (e2e, B-49)', () => {
  let root: string
  let dir: string
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-output-shape-miss-' })
    // No `rm -rf dist`: the clean before the miss is all that clears it.
    dir = await addProject(root, 'app', {
      config: CONFIG.replace('sh build.sh', 'sh miss.sh'),
      files: {
        'build.sh': '',
        'miss.sh': `set -e
mkdir -p dist
case "$(cat shape.txt)" in
  dir) mkdir dist/out && echo inner > dist/out/inner.txt ;;
  file) echo flat > dist/out ;;
esac
`,
      },
    })
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'keeps the glob’s root and prunes the directory the new shape needs as a file',
    async () => {
      const miss = async (shape: 'dir' | 'file') => {
        await writeFile(path.join(dir, 'shape.txt'), shape)
        const r = await summarized(root, ['app#build'])
        expect({ code: r.code, status: r.tasks.get('app#build')?.['status'] }).toEqual({
          code: 0,
          status: 'success',
        })
      }
      await miss('dir')
      // A mode `mkdir -p` never gives: the same directory survives the
      // clean only if it keeps it (an inode number is reused on ext4).
      await chmod(path.join(dir, 'dist'), 0o700)
      await miss('file')
      expect(await shapeOf(dir)).toEqual(EXPECTED.file)
      expect((await lstat(path.join(dir, 'dist'))).mode & 0o777).toBe(0o700)
    },
    TIMEOUT,
  )
})

// A literal output names a file or a tree, so the clean prunes the literal's
// own directory: a miss or a restore that needs a file there finds none.
describe('a literal output across a shape change (e2e)', () => {
  it(
    'misses and restores replace a directory with a file and back',
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-output-shape-literal-' })
      try {
        const app = await addProject(root, 'app', {
          config: `
            export default {
              tasks: {
                build: {
                  exec: { command: 'sh build.sh' },
                  inputs: { files: ['shape.txt', 'build.sh'] }, cache: { outputs: { files: ['dist/out'] } },
                },
              },
            }
          `,
          files: {
            // No `rm`: the clean is all that clears the other shape.
            'build.sh': `set -e
mkdir -p dist
case "$(cat shape.txt)" in
  dir) mkdir dist/out && echo inner > dist/out/inner.txt ;;
  file) echo flat > dist/out ;;
esac
`,
          },
        })
        const build = async (shape: 'dir' | 'file', status: 'success' | 'cache-hit') => {
          await writeFile(path.join(app, 'shape.txt'), shape)
          const r = await summarized(root, ['app#build'])
          expect({ code: r.code, status: r.tasks.get('app#build')?.['status'] }).toEqual({
            code: 0,
            status,
          })
          expect(await shapeOf(app)).toEqual(EXPECTED[shape])
        }
        await build('dir', 'success')
        await build('file', 'success')
        await build('dir', 'cache-hit')
        await build('file', 'cache-hit')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// A restore's clean removed a stray `out/a.txt` and pruned the emptied
// `out/`, which a sibling running beside it had just made and was about to
// write into: the sibling failed "Directory nonexistent". The entry holds
// nothing under `out`, so the restore never put it back; with one that
// does, the same prune opens a window between the clean and the extract.
describe('a restore beside a sibling writing into its directory (e2e)', () => {
  for (const [where, dir, outputs] of [
    ['project', 'out', `{ files: ['out/a.txt'] }`],
    ['workspace', '../../out', `{ files: [], workspaceFiles: ['out/a.txt'] }`],
  ] as const) {
    it(
      `leaves the sibling's ${where} directory standing`,
      async () => {
        const root = await makeWorkspace({ prefix: 'vx-restore-sibling-' })
        try {
          // The gate misses every run (its seed moves) and holds the build
          // until the sibling has made its directory. The build reads the
          // gate's constant output and folds no key of it, so it is keyed
          // after the gate, not restored ahead of the schedule, and hits.
          await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
          const app = await addProject(root, 'app', {
            config: `
              export default {
                tasks: {
                  gate: {
                    exec: { command: 'while [ ! -e ../../ready ]; do sleep 0.01; done; echo g > gate.out' },
                    inputs: { files: ['seed.txt'] }, cache: { outputs: { files: ['gate.out'] } },
                  },
                  build: {
                    dependsOn: ['gate'],
                    exec: { command: 'true' },
                    inputs: { files: ['gate.out'], tasks: [] }, cache: { outputs: ${outputs} },
                  },
                  after: { dependsOn: ['build'], exec: { command: 'touch ../../go' } },
                  other: {
                    exec: { command: 'mkdir -p ${dir} && touch ../../ready && while [ ! -e ../../go ]; do sleep 0.01; done; echo b > ${dir}/b.txt' },
                  },
                },
              }
            `,
            files: { 'seed.txt': '1' },
          })
          await writeFile(path.join(root, 'ready'), '')
          const first = await summarized(root, ['app#build'])
          expect(first.tasks.get('app#build')?.['status']).toBe('success')
          await rm(path.join(root, 'ready'))
          await writeFile(path.join(app, 'seed.txt'), '2')
          await Bun.write(path.join(app, dir, 'a.txt'), 'stray')

          // Two slots: gate and other wait on each other's markers, and a
          // one-core runner's default of one slot ran one forever.
          const r = await summarized(root, ['app#after', 'app#other', '--concurrency', '2'])
          const status = Object.fromEntries(
            ['app#build', 'app#other'].map((id) => [id, r.tasks.get(id)?.['status']]),
          )
          expect(status).toEqual({ 'app#build': 'cache-hit', 'app#other': 'success' })
          expect(await readFile(path.join(app, dir, 'b.txt'), 'utf8')).toBe('b\n')
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
      TIMEOUT,
    )
  }
})
