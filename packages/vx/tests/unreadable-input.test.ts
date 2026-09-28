// An input this user cannot read failed its task with the hint for a path
// vx must WRITE ("a path vx must write is not writable by this user"): the
// scheduler read every EACCES as a write refusal. The key's read names
// itself (A-50).
import { chmod, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { skipAsRoot } from './helpers/nonroot-gate.js'
import {
  addProject,
  type Fixture,
  makeWorkspace,
  silentLogger,
  TIMEOUT,
} from './helpers/orchestrator-fixture.js'
import { run } from '../src/orchestrator/index.js'

const CONFIG = `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
} } }`

let fx: Fixture
let secret: string
beforeEach(async () => {
  fx = await makeWorkspace('vx-unread-in-')
  const dir = await addProject(fx.root, 'app', {
    files: { 'src/a.txt': 'a', 'src/secret.txt': 's' },
    config: CONFIG,
  })
  secret = path.join(dir, 'src', 'secret.txt')
})
afterEach(async () => {
  await chmod(secret, 0o644).catch(() => undefined)
  await rm(fx.root, { recursive: true, force: true })
})

describe('an input this user cannot read', () => {
  it.skipIf(skipAsRoot('an unreadable input names the read, not a write'))(
    'fails its task naming the read, not a write',
    async () => {
      // Control: readable, it runs.
      const ok = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
      expect(ok.outcomes.map((o) => o.status)).toEqual(['success'])
      await chmod(secret, 0o000)
      const r = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
      expect(r.outcomes.map((o) => o.status)).toEqual(['failed'])
      expect(fx.err.filter((l) => l.includes('[vx] app#build:')).map((l) => l.trim())).toEqual([
        `[vx] app#build: ${secret} is not readable by this user (EACCES), and vx reads it to ` +
          'derive a cache key. Make it readable, or, for a task input, take it out of ' +
          'cache.inputs.files.',
      ])
    },
    TIMEOUT,
  )
})
