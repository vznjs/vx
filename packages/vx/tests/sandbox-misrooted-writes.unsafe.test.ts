import { realpathSync } from 'node:fs'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox misrooted writes test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

// Next's standalone copy, in shell: find up the nearest lockfile by stat,
// then copy a traced file to `.next/standalone/<its path from that root>`.
const STANDALONE = [
  'r=$PWD; while [ "$r" != / ] && [ ! -e "$r/bun.lock" ]; do r=$(dirname "$r"); done',
  '[ "$r" = / ] && r=$PWD',
  'f=$(realpath node_modules/next/dist/x.js)',
  'rel=$(realpath -s --relative-to="$r" "$f")',
  'mkdir -p ".next/standalone/$(dirname "$rel")"',
  'cp "$f" ".next/standalone/$rel"',
].join('; ')

describe.skipIf(!available || process.platform !== 'linux')(
  'a root found inside the project',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-misroot-' }))
      await writeFile(path.join(root, 'bun.lock'), '{}\n')
      const pkg = path.join(root, 'node_modules/.bun/next@1/node_modules/next')
      await mkdir(path.join(pkg, 'dist'), { recursive: true })
      await writeFile(path.join(pkg, 'dist/x.js'), 'x\n')
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    const build = async (write: string[], read = ['.']) => {
      const app = await addProject(root, 'web', {
        config: `export default { tasks: { build: {
        exec: { command: ${JSON.stringify(STANDALONE)},
          sandbox: { allow: { read: ${JSON.stringify(read)}, write: ${JSON.stringify(write)} } } },
        cache: true,
        inputs: { files: ['app/**'] },
        outputs: { files: ['.next/**'] },
      } } }\n`,
      })
      await mkdir(path.join(app, 'node_modules'), { recursive: true })
      await symlink(
        '../../../node_modules/.bun/next@1/node_modules/next',
        path.join(app, 'node_modules/next'),
      )
      return (await run({ cwd: root, tasks: ['build'], log: quiet })).outcomes[0]
    }

    // A file grant binds its directory, so the stray write lands and is
    // reported; a directory grant alone refuses the `mkdir` instead.
    it.each([
      ['a file grant beside', ['.next/**', 'next-env.d.ts']],
      ['a directory grant alone', ['.next/']],
    ])(
      'with %s, is told the hidden lockfile, never a write grant into node_modules',
      async (_, write) => {
        const o = await build(write)
        expect(o?.status).toBe('failed')
        expect(o?.sandbox?.fix).toEqual({ read: ['../../bun.lock'], workspaceFiles: ['bun.lock'] })
        expect(o?.sandbox?.lines?.at(-1)).toMatch(
          /^vx: the task wrote installed packages' files under the project \(node_modules\/\.bun.*\), which \.\.\/\.\.\/node_modules\/\.bun holds: it took the project for its root, .* grant what it looks for: `allow: \{ read: \['\.\.\/\.\.\/bun\.lock'\] \}`\.$/,
        )
      },
    )

    it('applied as given, the copy lands where it belongs', async () => {
      const o = await build(['.next/**', 'next-env.d.ts'], ['.', '../../bun.lock'])
      expect([o?.status, o?.sandbox?.lines ?? []]).toEqual(['success', []])
      const copied = path.join(
        root,
        'packages/web/.next/standalone/node_modules/.bun/next@1/node_modules/next/dist/x.js',
      )
      expect(await Bun.file(copied).text()).toBe('x\n')
    })
  },
)
