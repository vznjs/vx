// A watch cycle of hits says so in one line (`sayAllCached`). A group or a
// no-op task in the closure settles `success` without engaging the cache,
// and its outcome silenced the line: `vx watch test --all` over the `test`
// group convention, or any build behind a package's default `build`, said
// nothing for a cycle back to cached bytes.

import { afterEach, describe, expect, it } from 'bun:test'
import { sayAllCached } from '../src/cli/watch-loop.js'

const OPTS = { cwd: '.', tasks: ['build'], outputLogs: 'none' as const }
const written: string[] = []
const realWrite = process.stdout.write.bind(process.stdout)

function capture(): void {
  written.length = 0
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as typeof process.stdout.write
}

afterEach(() => {
  process.stdout.write = realWrite
})

const task = (status: string) => ({ status, node: { config: { exec: { command: 'x' } } } })
const noExec = (inputs?: { files: string[] }) => ({
  status: 'success',
  node: { config: inputs === undefined ? { dependsOn: [] } : { inputs } },
})

describe('sayAllCached', () => {
  it('counts the hits and passes over groups and no-op tasks', () => {
    capture()
    sayAllCached(OPTS, [
      noExec({ files: ['src/**'] }),
      task('cache-hit'),
      noExec(),
      task('cache-hit-remote'),
    ])
    process.stdout.write = realWrite
    expect(written.join('')).toContain('2 tasks cached, nothing ran')
  })

  it('stays silent when a task ran', () => {
    capture()
    sayAllCached(OPTS, [noExec(), task('cache-hit'), task('success')])
    process.stdout.write = realWrite
    expect(written.join('')).toBe('')
  })

  it('stays silent when only groups settled', () => {
    capture()
    sayAllCached(OPTS, [noExec(), noExec({ files: ['a'] })])
    process.stdout.write = realWrite
    expect(written.join('')).toBe('')
  })
})
