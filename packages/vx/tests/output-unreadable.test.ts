// An output this user cannot read (`chmod 000`) is not cached, and the
// warning names the output and the fix. It used to surface the raw
// errno line (`EACCES: permission denied, open '/abs/…/dist/s'`), which
// named neither the task's output nor what to do.

import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import { vx } from './helpers/parity.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

it.skipIf(skipAsRoot('an unreadable output is named, not cached'))(
  'an unreadable output is named, not cached',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-unreadable-out-' })
    made.push(root)
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && echo a > dist/a && echo s > dist/s && chmod 000 dist/s' },
              inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
            },
          },
        }
      `,
      files: { 'src/in.txt': 'v1\n', '.gitignore': 'dist\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const r = await vx(root, ['run', 'build', '--all', '--cache-dir', path.join(root, '.cache')])
    expect(r.code).toBe(0)
    expect(r.err).toContain(
      "cache save failed: app#build: output dist/s is not readable by this user: vx cannot cache it — make it readable (chmod u+r), or take it back with a '!' entry",
    )
    expect(r.err).not.toContain('EACCES')
  },
  60_000,
)
