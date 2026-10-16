// A hit applies the restoring process's umask to the modes it writes, as
// tar does for a non-root user and Turbo does: under `umask 077` a build
// leaves 0600 / 0700, and a hit gave back 0644 / 0755, readable by every
// user on the machine (Growth's restore-ignores-umask.sh, 2026-10-16).

import { rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

const modes = (dir: string, names: string[]) =>
  names.map((n) => (statSync(path.join(dir, n)).mode & 0o777).toString(8))

it.skipIf(process.platform === 'win32')(
  'a hit under umask 077 restores 0600 / 0700, and the tree it leaves is current',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-umask-' })
    made.push(root)
    const app = await addProject(root, 'app', {
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && cp src/a.txt dist/out.txt && printf "#!/bin/sh\\\\n" > dist/run.sh && chmod +x dist/run.sh' },
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
    rmSync(path.join(app, 'dist'), { recursive: true })
    const before = process.umask(0o077)
    try {
      const hit = await build()
      expect(`${hit.code}\n${hit.err}`).toStartWith('0\n')
      expect(modes(app, ['dist/out.txt', 'dist/run.sh'])).toEqual(['600', '700'])
      // The next hit finds that tree current: no second restore.
      const again = await build()
      expect(`${again.code}\n${again.err}`).toStartWith('0\n')
      expect(again.out + again.err).toContain('local 1✓')
    } finally {
      process.umask(before)
    }
  },
  60_000,
)
