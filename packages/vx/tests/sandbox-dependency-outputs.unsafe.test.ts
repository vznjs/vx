// A sandboxed task reads the declared outputs of the tasks its key folds
// (its `dependsOn`), in any project: a `tools` project builds Node once and
// every other project runs it. Safe because the key already moves with
// them: a dependency's key folds the files that made its outputs. The
// dependency's sources, and the outputs of a task it does not depend on,
// stay behind the project wall.
import { realpathSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { taskShell } from '../src/util/index.js'
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

  const peek = async (
    use: string,
    sandbox = `{ allow: { read: ['.'] } }`,
    cache = 'cache: true,',
  ): Promise<string[]> => {
    await addProject(fixture.root, 'tools', {
      files: { 'src/s.txt': 'SRC\n' },
      config: `
        export default {
          tasks: {
            node: {
              exec: { command: 'mkdir -p out/bin && echo OUT > out/bin/tool.txt && echo ROOT > root.txt' },
              inputs: { files: ['src/**'] },
              outputs: { files: ['out/**', '*.txt'] },
              ${cache}
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
    'an uncached dependency’s outputs are readable too',
    async () => {
      expect(await peek(`dependsOn: ['tools#node'],`, undefined, '')).toEqual([
        'OUT',
        'NOSRC',
        'ROOT',
      ])
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

  // `tsc -b` touches an up-to-date dependency's buildinfo when its sources
  // are newer than it (a branch switched and back, the dependency a hit),
  // and swallows the refusal; judged a write, the dependant failed every
  // run until `--force` (tsref repro1, 2026-11-12). The bind is read-only:
  // the touch lands nothing, and the dependency's file keeps its time.
  // `touch` without `-c` opens the file for writing first, and so does
  // uutils' (Ubuntu 26.04) with it: that refused open is the touch too.
  // Linux only: seatbelt logs a refused utimes as `file-write*`, as it logs
  // a refused write, so macOS cannot tell the touch from a write.
  it.skipIf(process.platform !== 'linux')(
    'a refused timestamp change on a dependency’s output is no violation and moves nothing',
    async () => {
      await addProject(fixture.root, 'tools', {
        files: { 'src/s.txt': 'SRC\n' },
        config: `export default { tasks: { node: {
          exec: { command: 'mkdir -p out/bin && echo OUT > out/bin/tool.txt && echo ROOT > root.txt' },
          inputs: { files: ['src/**'] }, outputs: { files: ['out/**', '*.txt'] }, cache: true,
        } } }`,
      })
      const rel = '../tools/out/bin/tool.txt'
      const touch = `touch -c ${rel} 2>/dev/null; touch ${rel} 2>/dev/null; ${PEEK}`
      await addProject(fixture.root, 'app', {
        files: { 'src/a.txt': 'A\n' },
        config: `export default { tasks: { use: {
          exec: { command: ${JSON.stringify(touch)}, sandbox: { allow: { read: ['.'] } } },
          dependsOn: ['tools#node'],
        } } }`,
      })
      const log = collectingLogger(fixture)
      expect((await run({ cwd: fixture.root, tasks: ['node'], log })).ok).toBe(true)
      const tool = path.join(fixture.root, 'packages', 'tools', 'out', 'bin', 'tool.txt')
      const before = statSync(tool).mtimeMs
      fixture.log.length = 0
      const r = await run({ cwd: fixture.root, tasks: ['use'], log })
      const refused = r.outcomes.flatMap((o) => o.sandboxViolationLines ?? [])
      expect({
        ok: r.ok,
        hinted: fixture.log.join('\n').includes('no grant covers'),
        ...(r.ok ? {} : { refused, log: fixture.log }),
      }).toEqual({ ok: true, hinted: false })
      expect(statSync(tool).mtimeMs).toBe(before)
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

// Only the files the dependency's globs take are its outputs: a file
// beside them under the same head (one the dependency left, or one a `!`
// entry takes back) is no output, no key answers for it, and an edit to it
// replayed the old result as a hit. It stays hidden, and reaching for it is
// reported.
describe.skipIf(!available)('a dependency’s non-output files stay hidden', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const READ = [
    'read o 2>/dev/null < ../tools/gen/out.js && echo "$o" || echo NOOUT',
    'read s 2>/dev/null < ../tools/gen/sub/s.js && echo "$s" || echo NOSUB',
    'read n 2>/dev/null < ../tools/gen/notes.txt && echo "$n" || echo NONOTE',
  ].join('; ')

  const peek = async (outputs: string[]) => {
    const tools = await addProject(fixture.root, 'tools', {
      files: { 'src/s.txt': 'SRC\n' },
      config: `
        export default {
          tasks: {
            gen: {
              exec: { command: 'mkdir -p gen/sub && echo OUT > gen/out.js && echo SUB > gen/sub/s.js && echo NOTE > gen/notes.txt' },
              inputs: { files: ['src/**'] },
              outputs: { files: ${JSON.stringify(outputs)} },
              cache: true,
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
              exec: { command: ${JSON.stringify(READ)}, sandbox: { allow: { read: ['.'] } } },
              dependsOn: ['tools#gen'],
              inputs: { files: ['src/**'] },
              outputs: { files: [] },
              cache: true,
            },
          },
        }
      `,
    })
    const r = await run({ cwd: fixture.root, tasks: ['use'], log: collectingLogger(fixture) })
    const seen = fixture.log
      .flatMap((l) => l.split('\n'))
      .map((l) => l.trim())
      .filter((l) => /^(OUT|NOOUT|SUB|NOSUB|NOTE|NONOTE)$/.test(l))
    const use = r.outcomes.find((o) => o.node.id === 'app#use')
    return { seen, use, notes: path.join(realpathSync(tools), 'gen', 'notes.txt') }
  }

  for (const outputs of [['gen/**/*.js'], ['gen/**', '!gen/notes.txt']]) {
    it(
      `${JSON.stringify(outputs)}: the outputs are readable, gen/notes.txt is not`,
      async () => {
        const { seen, use, notes } = await peek(outputs)
        expect(seen).toEqual(['OUT', 'SUB', 'NONOTE'])
        // The refused read is what keeps the hit honest: the task saw no
        // notes.txt, so its result does not depend on it. Reporting it is
        // strace's on Linux; macOS's log stream dropped the record once on
        // CI (#5124), so there the run may pass on what it could read.
        if (process.platform === 'linux') expect(use?.status).toBe('failed')
        if (process.platform === 'linux')
          expect(use?.sandboxViolationLines).toEqual([
            `openat(../tools/gen/notes.txt) = -1 ENOENT  [${notes}]`,
          ])
      },
      TIMEOUT,
    )
  }
})

describe.skipIf(!available)('a hermetic task runs a program its dependency built', () => {
  let fixture: Fixture

  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  // The task shell is the one interpreter a hermetic task reads unnamed;
  // macOS's `/bin/sh` is a stub that is not it.
  const SHELL = taskShell()

  it(
    'by its path in the dependency’s outputs',
    async () => {
      await addProject(fixture.root, 'tools', {
        files: { 'src/s.txt': 'SRC\n' },
        config: `
          export default {
            tasks: {
              node: {
                exec: { command: ${JSON.stringify(
                  `mkdir -p out/bin && printf '#!${SHELL}\\necho TOOLRAN\\n' > out/bin/hello && chmod +x out/bin/hello`,
                )} },
                inputs: { files: ['src/**'] },
                outputs: { files: ['out/**'] },
                cache: true,
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
                exec: { command: '../tools/out/bin/hello', sandbox: { hermetic: true, allow: { read: ['.'] } } },
                dependsOn: ['tools#node'],
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['use'], log: collectingLogger(fixture) })
      if (!r.ok) throw new Error(`run failed:\n${fixture.log.join('\n')}`)
      expect(fixture.log.join('\n')).toContain('TOOLRAN')
    },
    TIMEOUT,
  )

  it(
    'a write into them is the dependency’s work: no grant to write there is suggested',
    async () => {
      // `tsc -b` under --exclude-dependencies rebuilt the upstream project,
      // and the hints suggested `write: ['../tools/out/bin/tool.txt']` and
      // `['../']` for a refused write of its headless `*.txt` output.
      await addProject(fixture.root, 'tools', {
        files: { 'src/s.txt': 'SRC\n' },
        config: `
          export default {
            tasks: {
              node: {
                exec: { command: 'mkdir -p out/bin && echo OUT > out/bin/tool.txt && echo ROOT > root.txt' },
                inputs: { files: ['src/**'] },
                outputs: { files: ['out/**', '*.txt'] },
                cache: true,
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
                exec: {
                  command: 'echo X > ../tools/out/bin/tool.txt; echo X > ../tools/root.txt',
                  sandbox: { allow: { read: ['.'] } },
                },
                dependsOn: ['tools#node'],
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['use'], log: collectingLogger(fixture) })
      const use = r.outcomes.find((o) => o.node.id === 'app#use')!
      expect(use.status).toBe('failed')
      expect(use.sandboxFix?.write).toBeUndefined()
      const lines = use.sandboxViolationLines ?? []
      expect(lines.filter((l) => l.includes('outside the project'))).toEqual([])
      const named = lines
        .filter((l) => l.includes("a dependency's declared outputs"))
        .map((l) => ['../tools/out/bin/tool.txt', '../tools/root.txt'].every((p) => l.includes(p)))
      expect(named.join() === 'true' ? named : { named, lines, log: fixture.log }).toEqual([true])
    },
    TIMEOUT,
  )
})
