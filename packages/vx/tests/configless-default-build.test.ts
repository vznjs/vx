// A package with no vx config is a source a dependant may bundle: its
// default `build` (owner, 2026-10-04) keys its files behind `^build`. It
// was loaded only when some `project` plugin existed, so with none an edit
// to it replayed the dependant's stale output as a hit (X-9).

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'

let fixture: Fixture | undefined
afterEach(async () => {
  if (fixture) await rm(fixture.root, { recursive: true, force: true })
  fixture = undefined
})

it(
  "an edit to a config-less dependency re-keys its dependant's build",
  async () => {
    const f = (fixture = await makeWorkspace('vx-configless-'))
    const lib = await addProject(f.root, 'lib', { files: { 'src/index.js': 'v1\n' } })
    await addProject(f.root, 'app', {
      deps: { lib: 'workspace:*' },
      files: { 'src/index.js': 'app\n' },
      config: `export default { tasks: { build: {
        dependsOn: ['^build'],
        exec: { command: 'true' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
      } } }\n`,
    })
    const hash = async (): Promise<string | undefined> => {
      const r = await run({ cwd: f.root, tasks: ['app#build'], log: silentLogger(f) })
      expect(r.ok).toBe(true)
      return r.outcomes.find((o) => o.node.id === 'app#build')?.hash
    }
    const before = await hash()
    // Control: nothing changed, the key holds.
    expect(await hash()).toBe(before)
    await writeFile(path.join(lib, 'src/index.js'), 'v2\n')
    expect(await hash()).not.toBe(before)
  },
  TIMEOUT,
)
