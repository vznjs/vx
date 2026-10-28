// A hit gives each output directory it makes the mode the miss left. It made
// every one with mkdir's default: a `chmod 700 dist/keys` came back 0755 on a
// fresh checkout or after `rm -rf dist`, and every user on the machine could
// read the 0644 files the directory had kept to its owner.

import { rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const modes = (dir: string, names: string[]) =>
  names.map((n) => `${n} ${(statSync(path.join(dir, n)).mode & 0o777).toString(8)}`)

const NAMES = ['dist', 'dist/keys', 'dist/keys/id', 'dist/ro', 'dist/empty', 'dist/open']
const EXPECTED = [
  'dist 755',
  'dist/keys 700',
  'dist/keys/id 644',
  'dist/ro 555',
  'dist/empty 700',
  'dist/open 755',
]

// Under the store's 32 KiB inline limit the hit reads the archive; past it,
// the store keeps plain files and a hit into absent outputs copies them out.
for (const [form, extra] of [
  ['an inline archive', ''],
  ['a plain-file tree', ' && head -c 100000 /dev/zero > dist/open/big'],
] as const) {
  it.skipIf(process.platform === 'win32')(
    `a hit from ${form} restores the modes of the output directories it makes`,
    async () => {
      const before = process.umask(0o022)
      try {
        const root = await makeWorkspace({ prefix: 'vx-dir-mode-' })
        made.push(root)
        const app = await addProject(root, 'app', {
          config: `export default { tasks: { build: {
            exec: { command: 'mkdir -p dist/keys dist/ro dist/empty dist/open && echo k > dist/keys/id && echo r > dist/ro/f && echo o > dist/open/f${extra} && chmod 700 dist/keys dist/empty && chmod 555 dist/ro' },
            inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
          } } }`,
          files: { 'src/a.txt': 'a\n', '.gitignore': 'dist/\n' },
        })
        const git = gitIn(root)
        git('add', '-A')
        git('commit', '-q', '-m', 'init')
        const cacheDir = path.join(root, '.cache')
        const build = () => vx(root, ['run', 'build', '--all', '--cache-dir', cacheDir])
        const cold = await build()
        expect(`${cold.code}\n${cold.err}`).toStartWith('0\n')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        rmSync(path.join(app, 'dist'), { recursive: true })
        const fresh = await build()
        expect(`${fresh.code}\n${fresh.err}`).toStartWith('0\n')
        expect(fresh.out + fresh.err).toContain('local 1↓')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        // A restore into a tree that is partly there makes only what is missing.
        rmSync(path.join(app, 'dist/keys'), { recursive: true })
        writeFileSync(path.join(app, 'dist/open/f'), 'changed\n')
        const partial = await build()
        expect(`${partial.code}\n${partial.err}`).toStartWith('0\n')
        expect(partial.out + partial.err).toContain('local 1↓')
        expect(modes(app, NAMES)).toEqual(EXPECTED)

        // The tree it leaves is current: the next hit restores nothing.
        const again = await build()
        expect(`${again.code}\n${again.err}`).toStartWith('0\n')
        expect(again.out + again.err).toContain('local 1✓')
      } finally {
        process.umask(before)
      }
    },
    60_000,
  )
}
