// "vx never deletes a git-tracked file": a committed file reached through
// an untracked link at an output glob's head (`public -> static`, made by a
// setup script) was asked about as `public/logo.txt`, a path git never
// lists, and the clean before the miss deleted `static/logo.txt`.

import { existsSync, symlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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
        inputs: { files: ['src/**'] }, cache: { outputs: { files: ['public/**'] } },
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
