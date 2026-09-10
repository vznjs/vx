// The miss path's output-directory snapshot is taken at run end, not right
// after the save: a directory the task wrote milliseconds ago sits inside
// the snapshot's racy window (`OUTPUT_DIRS_RACY_MS`) and a snapshot taken
// then is refused — so every first warm run after a cold build walked
// every output tree (1,000 walks, 296 ms accumulated, on the bench).
// Differential: the second project's task keeps the run alive past the
// window, so the first project's directories are old enough by run end;
// before the change the rows were absent after this same run.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { Cache } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'
import {
  addProject,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
  type Fixture,
} from './helpers/orchestrator-fixture.js'

let fixture: Fixture
beforeEach(async () => {
  fixture = await makeWorkspace('vx-dir-snapshot-')
})
afterEach(async () => {
  await rm(fixture.root, { recursive: true, force: true })
})

it(
  'a cold build records its output directories by run end, so the next hit skips the walk',
  async () => {
    await addProject(fixture.root, 'a', {
      files: { 'src/x.txt': 'x\n' },
      config: `export default { tasks: { build: {
        exec: { command: 'mkdir -p dist && cp src/x.txt dist/out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      } } }\n`,
    })
    // Keeps the run alive past the racy window after a's save.
    await addProject(fixture.root, 'b', {
      files: {},
      config: `export default { tasks: { build: { exec: { command: 'sleep 0.15' } } } }\n`,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['build'],
      log: silentLogger(fixture),
      handleSignals: false,
    })
    expect(r.ok).toBe(true)
    const a = r.outcomes.find((o) => o.node.id === 'a#build')!
    expect(a.status).toBe('success')
    const cache = new Cache(path.join(fixture.root, '.vx', 'cache'))
    try {
      const entry = (await cache.getMany([a.hash!])).get(a.hash!)
      expect(entry?.outputDirRows?.map((d) => d.path)).toEqual(['dist'])
    } finally {
      cache.close()
    }
  },
  TIMEOUT,
)
