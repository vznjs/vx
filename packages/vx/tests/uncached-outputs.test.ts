// An uncached task declares outputs too: `cache` only switches the save.
// Its `bin` is on its dependants' PATH, and with nothing saved there is no
// snapshot to keep exact, so its outputs are never cleaned before it runs.
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import {
  TIMEOUT,
  type Fixture,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

describe('an uncached task’s outputs', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'its bin is on a dependant’s PATH',
    async () => {
      await addProject(fixture.root, 'node', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: ${JSON.stringify(
                  `mkdir -p out/bin && printf '#!/bin/sh\\necho NODE\\n' > out/bin/hello && chmod +x out/bin/hello`,
                )} },
                outputs: { files: ['out/**'], bin: 'out/bin' },
              },
            },
          }
        `,
      })
      await addProject(fixture.root, 'app', {
        config: `
          export default {
            tasks: { use: { exec: { command: 'hello' }, dependsOn: ['node#build'] } },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['use'], log: collectingLogger(fixture) })
      expect(fixture.log.join('\n')).toContain('NODE')
      expect(r.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'are not cleaned before it runs',
    async () => {
      await addProject(fixture.root, 'gen', {
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: 'mkdir -p out && echo NEW > out/new.txt' },
                outputs: { files: ['out/**'] },
              },
            },
          }
        `,
      })
      const out = path.join(fixture.root, 'gen', 'out')
      await mkdir(out, { recursive: true })
      await writeFile(path.join(out, 'old.txt'), 'OLD\n')
      const r = await run({ cwd: fixture.root, tasks: ['gen'], log: collectingLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(await readFile(path.join(out, 'old.txt'), 'utf8')).toBe('OLD\n')
      expect(await readFile(path.join(out, 'new.txt'), 'utf8')).toBe('NEW\n')
    },
    TIMEOUT,
  )
})
