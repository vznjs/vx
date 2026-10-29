// An input this user cannot read failed its task with the hint for a path
// vx must WRITE ("a path vx must write is not writable by this user"): the
// scheduler read every EACCES as a write refusal. The key's read names
// itself (A-50).
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
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
import { run } from './helpers/orchestrator.js'

const CONFIG = `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
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
  await chmod(path.join(path.dirname(secret), 'locked'), 0o755).catch(() => undefined)
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
          'inputs.files.',
      ])
    },
    TIMEOUT,
  )

  // vercel/turborepo#6957: a directory under an input glob that this user
  // may not enter failed the run ("failed to match directory tree"). An
  // untracked one holds nothing git or vx can read: it is no input.
  it.skipIf(skipAsRoot('an unsearchable input directory is skipped'))(
    'skips an untracked directory under its globs that it may not enter, and runs',
    async () => {
      const locked = path.join(path.dirname(secret), 'locked')
      await mkdir(locked)
      await writeFile(path.join(locked, 'x.txt'), 'x')
      await chmod(locked, 0o000)
      const r = await run({ cwd: fx.root, tasks: ['build'], log: silentLogger(fx) })
      expect({ status: r.outcomes.map((o) => o.status), err: fx.err }).toEqual({
        status: ['success'],
        err: [],
      })
    },
    TIMEOUT,
  )
})
