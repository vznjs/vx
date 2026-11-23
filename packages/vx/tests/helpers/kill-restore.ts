// A staged output's restore (`stagedOutputs`) killed between its two
// renames: the host's directory is set aside, the task's not yet in place.
// argv: <workspace dir>; the output directory is `<dir>/app/dist`.
import * as fs from 'node:fs'
import path from 'node:path'
import { mock } from 'bun:test'

const rename = fs.renameSync
void mock.module('node:fs', () => ({
  ...fs,
  renameSync: (from: string, to: string) => {
    if (path.basename(from) === 'dist' && from.includes('/.vx/tmp/'))
      process.kill(process.pid, 'SIGKILL')
    rename(from, to)
  },
}))
const { stagedOutputs } = await import('../../src/sandbox/binds.js')
const dir = process.argv[2]!
const dist = path.join(dir, 'app', 'dist')
stagedOutputs(`bwrap --tmpfs ${dir} --bind ${dist} ${dist} -- sh`, {
  cwd: path.join(dir, 'app'),
  allowRead: [],
  allowWrite: [dist],
  granted: [dist],
  owned: [dist],
  tag: '0123456789abcdef',
})!.restore()
