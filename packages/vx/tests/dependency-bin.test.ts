// `cache.outputs.bin`: a task names the directory of its outputs that holds
// programs, and each task that depends on it gets that directory first on
// PATH (Nix's `nix develop`, declared, never read from a layout). Two dependencies shipping one program name refuse the
// task, naming both: PATH order would pick one silently.
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import {
  TIMEOUT,
  type Fixture,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const tool = (word: string, bin = `bin: 'out/bin',`): string => `
  export default {
    tasks: {
      build: {
        exec: { command: ${JSON.stringify(
          `mkdir -p out/bin && printf '#!/bin/sh\\necho ${word}\\n' > out/bin/hello && chmod +x out/bin/hello`,
        )} },
        inputs: { files: ['src/**'] },
        cache: { outputs: { files: ['out/**'], ${bin} } },
      },
    },
  }
`

describe('a dependency’s declared bin directory is on its dependants’ PATH', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const use = async (dependsOn: string[]) => {
    await addProject(fixture.root, 'app', {
      files: { 'src/a.txt': 'A\n' },
      config: `
        export default {
          tasks: {
            use: { exec: { command: 'hello' }, dependsOn: ${JSON.stringify(dependsOn)} },
          },
        }
      `,
    })
    const r = await run({ cwd: fixture.root, tasks: ['use'], log: collectingLogger(fixture) })
    return { ok: r.ok, log: fixture.log.join('\n') }
  }

  it(
    'a dependant runs the program by name',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool('NODE'),
      })
      const r = await use(['node#build'])
      expect(r.log).toContain('NODE')
      expect(r.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'CONTROL: without `bin`, the program is not on PATH',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool('NODE', ''),
      })
      const r = await use(['node#build'])
      expect(r.ok).toBe(false)
      expect(r.log).not.toContain('NODE')
    },
    TIMEOUT,
  )

  it(
    'two dependencies shipping one program name refuse the task, naming both',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool('NODE'),
      })
      await addProject(fixture.root, 'bun', { files: { 'src/s.txt': 's\n' }, config: tool('BUN') })
      const r = await use(['node#build', 'bun#build'])
      expect(r.ok).toBe(false)
      expect(r.log).not.toContain('NODE')
      expect(r.log).not.toContain('BUN')
      expect(r.log).toContain("'hello'")
      expect(r.log).toContain('node#build')
      expect(r.log).toContain('bun#build')
    },
    TIMEOUT,
  )
})
