// Args after `--` go only to requested tasks with a command; a request
// that named only groups dropped them and passed (X-14).
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { makeWorkspace, silentLogger, type Fixture } from './helpers/orchestrator-fixture.js'
import { addProject } from './helpers/workspace.js'

const CONFIG = `export default {
  tasks: {
    compile: { exec: { command: 'echo compiled' } },
    build: { dependsOn: ['compile'] },
  },
}
`

describe('forwarded args and groups', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace('vx-fwd-group-')
    await addProject(fixture.root, 'a', CONFIG)
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const said = (tasks: string[], forwardArgs: string[]) =>
    run({ cwd: fixture.root, tasks, forwardArgs, log: silentLogger(fixture) })
      .then((r) => (r.ok ? 'ok' : 'failed'))
      .catch((e: Error) => e.message)

  it('refuses args that would reach only a group', async () => {
    expect(await said(['build'], ['--watch'])).toBe(
      'args after `--` reach no task: a#build has no command (a group); name the task that runs one',
    )
  })

  it('runs when a requested task has a command, or no args were given', async () => {
    expect([
      await said(['build', 'compile'], ['--x']),
      await said(['compile'], ['--x']),
      await said(['build'], []),
    ]).toEqual(['ok', 'ok', 'ok'])
  })
})
