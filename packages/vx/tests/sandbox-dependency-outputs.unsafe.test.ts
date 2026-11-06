// A sandboxed task reads the declared outputs of the tasks its key folds
// (its `dependsOn`), in any project: a `tools` project builds Node once and
// every other project runs it. Safe because the key already moves with
// them: a dependency's key folds the files that made its outputs. The
// dependency's sources, and the outputs of a task it does not depend on,
// stay behind the project wall.
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import {
  TIMEOUT,
  type Fixture,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const available = await sandboxAvailable('sandbox dependency outputs test')

// Builtins only, so a hermetic run needs no granted program.
const PEEK = [
  'read t 2>/dev/null < ../tools/out/bin/tool.txt && echo "$t" || echo NOOUT',
  'read s 2>/dev/null < ../tools/src/s.txt && echo "$s" || echo NOSRC',
  'read r 2>/dev/null < ../tools/root.txt && echo "$r" || echo NOROOT',
].join('; ')

describe.skipIf(!available)('a sandboxed task reads the outputs it depends on', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const peek = async (use: string, sandbox = `{ allow: { read: ['.'] } }`): Promise<string[]> => {
    await addProject(fixture.root, 'tools', {
      files: { 'src/s.txt': 'SRC\n' },
      config: `
        export default {
          tasks: {
            node: {
              exec: { command: 'mkdir -p out/bin && echo OUT > out/bin/tool.txt && echo ROOT > root.txt' },
              inputs: { files: ['src/**'] },
              cache: { outputs: { files: ['out/**', '*.txt'] } },
            },
          },
        }
      `,
    })
    await addProject(fixture.root, 'app', {
      files: { 'src/a.txt': 'A\n' },
      config: `
        export default {
          tasks: {
            use: {
              exec: { command: ${JSON.stringify(PEEK)}, sandbox: ${sandbox} },
              ${use}
            },
          },
        }
      `,
    })
    const r = await run({
      cwd: fixture.root,
      tasks: ['node', 'use'],
      log: collectingLogger(fixture),
    })
    if (!r.ok) throw new Error(`run failed:\n${fixture.log.join('\n')}`)
    return fixture.log
      .flatMap((l) => l.split('\n'))
      .map((l) => l.trim())
      .filter((l) => /^(OUT|NOOUT|SRC|NOSRC|ROOT|NOROOT)$/.test(l))
  }

  it(
    'CONTROL: without the edge, another project’s outputs are hidden',
    async () => {
      expect(await peek('')).toEqual(['NOOUT', 'NOSRC', 'NOROOT'])
    },
    TIMEOUT,
  )

  it(
    'with the edge, its outputs are readable and its sources are not',
    async () => {
      expect(await peek(`dependsOn: ['tools#node'],`)).toEqual(['OUT', 'NOSRC', 'ROOT'])
    },
    TIMEOUT,
  )

  it(
    'a hermetic task reads them too',
    async () => {
      expect(
        await peek(`dependsOn: ['tools#node'],`, `{ hermetic: true, allow: { read: ['.'] } }`),
      ).toEqual(['OUT', 'NOSRC', 'ROOT'])
    },
    TIMEOUT,
  )

  it(
    'an edge the key does not fold grants nothing',
    async () => {
      expect(
        await peek(`dependsOn: ['tools#node'], inputs: { files: ['src/**'], tasks: [] },`),
      ).toEqual(['NOOUT', 'NOSRC', 'NOROOT'])
    },
    TIMEOUT,
  )
})
