// With a `workspaceFiles` input declared, one recursive watcher at the root
// replaces the per-project ones, and it named every edit `changed root
// packages/app/src/a.txt`: a project's own file read as the root's. A
// migrated Turbo repo (`globalDependencies` → `workspaceFiles`) hit it on
// every edit (DX bug hunt, 2026-10-15). The cycle names the project and
// the path inside it, as the per-project arms do.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  executions,
  initialOnly,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

describe('vx watch with a workspace-wide watcher (e2e)', () => {
  const f = useWatchFixture()

  it('names the project an edit is in, not root', async () => {
    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{}\n')
    await mkdir(path.join(f.dir, 'src'), { recursive: true })
    await writeFile(path.join(f.dir, 'src', 'a.txt'), '1\n')
    await writeFile(
      path.join(f.dir, 'vx.config.mjs'),
      `export default { tasks: {
        build: {
          exec: { command: 'echo run >> ${f.log}' },
          inputs: { files: ['src/**'], workspaceFiles: ['tsconfig.base.json'] }, cache: { outputs: { files: [] } },
        },
      } }\n`,
    )
    f.watch = startWatch(f.root, ['--all'], {}, 'build')
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)

    await writeFile(path.join(f.dir, 'src', 'a.txt'), '2\n')
    await until(async () => (await executions(f.log)) === 2, 'the re-run after the edit')
    expect(w.out()).toContain(`changed app ${path.join('src', 'a.txt')}`)

    await writeFile(path.join(f.root, 'tsconfig.base.json'), '{ }\n')
    await until(async () => (await executions(f.log)) === 3, 'the re-run after the root edit')
    expect(w.out()).toContain('changed root tsconfig.base.json')
  }, 40_000)
})
