// `vx --version` writes through `Bun.stdout`, not `process.stdout`: the
// Node stream's first touch was ~7 ms of a 16 ms verb (2026-10-02). It
// skips the stream's `error` listener too, so a reader that leaves must
// still not turn into a stack or a failed exit.
import path from 'node:path'
import { expect, it } from 'bun:test'
import { VERSION } from '../src/version.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

it('prints the version line and nothing else', () => {
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, '--version'],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect([r.exitCode, r.stdout.toString(), r.stderr.toString()]).toEqual([0, `vx ${VERSION}\n`, ''])
})

it('a reader that is gone is no failure', () => {
  // The reader exits before vx writes; vx's own status is the first.
  const r = Bun.spawnSync({
    cmd: [
      'bash',
      '-c',
      `exec 3>&1; (sleep 0.2; ${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} --version; echo "vx=$?" >&3) | true`,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect([r.stdout.toString(), r.stderr.toString()]).toEqual(['vx=0\n', ''])
})
