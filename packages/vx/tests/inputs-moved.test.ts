// A key is taken BEFORE the command runs, and a miss files the command's
// outputs under it. When an input changes in between — the task rewrites
// its own input (a formatter, turborepo#10111), the user edits one mid-run
// (turborepo#1146) — the entry holds bytes built from one state under the
// key of another, and restoring the old state replays them as up-to-date.
// The miss re-checks its inputs before the save and withholds the entry
// when one moved (item 743). Every row but the controls failed on the tree
// before the fix.

import { existsSync, lstatSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  Cache,
  type CacheLayer,
  FILE_HASH_RACY_MS,
  GitFilesCache,
  applyGitEnumeration,
  startGitEnumeration,
} from '../src/cache/index.js'
import type { TaskNode } from '../src/graph/index.js'
import type { Logger, RunSummary } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { describeTaskInputs, movedInput } from '../src/orchestrator/task-hash.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000
const MOVED = /changed after its key was taken/

let root: string
let status: string[]

const logger: Logger = {
  status: (line) => status.push(line),
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-moved-' })
  status = []
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function commit(): void {
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'fixture')
}

async function runTask(task: string): Promise<RunSummary> {
  status = []
  const r = await run({ cwd: root, tasks: [task], log: logger })
  expect(r.ok).toBe(true)
  return r
}

const statusOf = (r: RunSummary, id: string): string | undefined =>
  r.outcomes.find((o) => o.node.id === id)?.status

/** Resolves once `file` exists: the task under test has reached that line. */
async function reached(file: string): Promise<void> {
  while (!existsSync(file)) await Bun.sleep(5)
}

describe('a task that rewrites its own input', () => {
  it(
    'is not saved under the key of the bytes it rewrote, so restoring them re-runs it',
    async () => {
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              format: {
                exec: { command: "sed -i.bak 's/unformatted/formatted/' a.ts && rm a.ts.bak" },
                cache: { inputs: { files: ['a.ts'] }, outputs: { files: [] } },
              },
            },
          }
        `,
        files: { 'a.ts': 'const x = "unformatted"\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\n')
      commit()

      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#format: `packages/app/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it',
      ])
      gitIn(root)('checkout', '--', 'packages/app/a.ts')
      const again = await runTask('format')
      // Before the fix: `up-to-date`, and a.ts stayed unformatted.
      expect(statusOf(again, 'app#format')).toBe('success')
      expect(await readFile(path.join(app, 'a.ts'), 'utf8')).toBe('const x = "formatted"\n')
    },
    TIMEOUT,
  )

  it(
    'control: a rewrite to the SAME bytes is saved, and the next run hits',
    async () => {
      // sed -i rewrites the file (a new inode, a new ctime) even when it
      // changes nothing: the re-check compares content, not the write.
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              format: {
                exec: { command: "sed -i.bak 's/unformatted/formatted/' a.ts && rm a.ts.bak" },
                cache: { inputs: { files: ['a.ts'] }, outputs: { files: [] } },
              },
            },
          }
        `,
        files: { 'a.ts': 'const x = "formatted"\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\n')
      commit()
      await runTask('format')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      expect(statusOf(await runTask('format'), 'app#format')).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('the other moves', () => {
  it(
    'an input the task deletes: the entry is withheld',
    async () => {
      const app = await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              build: {
                exec: { command: 'mkdir -p dist; cat in/* > dist/out.txt; rm in/b.txt' },
                cache: { inputs: { files: ['in/**'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'in/a.txt': 'a', 'in/b.txt': 'b' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\n')
      commit()
      await runTask('build')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/in/b.txt` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it',
      ])
      gitIn(root)('checkout', '--', 'packages/app/in/b.txt')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      expect(statusOf(await runTask('build'), 'app#build')).toBe('success')
    },
    TIMEOUT,
  )

  it(
    "the project's package.json, which every key folds: the entry is withheld",
    async () => {
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              bump: {
                exec: { command: 'cp next.json package.json' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
              },
            },
          }
        `,
        files: {
          'src/a.txt': 'a',
          'next.json': JSON.stringify({ name: 'app', version: '1.0.0' }),
        },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\n')
      commit()
      await runTask('bump')
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#bump: `packages/app/package.json` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it',
      ])
      gitIn(root)('checkout', '--', 'packages/app/package.json')
      expect(statusOf(await runTask('bump'), 'app#bump')).toBe('success')
    },
    TIMEOUT,
  )
})

describe('what the run knew about the project goes with a move', () => {
  it(
    'a same-project reader after the rewrite is keyed on the new bytes, not the index OID',
    async () => {
      // `build` folds no upstream key (`tasks: []`) and is keyed after
      // `format` (which declares an output, so `build` is not keyed up
      // front). The first run's `format` leaves `a.ts` alone and `build`
      // saves under a.ts = U. Then `format` learns to rewrite U to F: the
      // rewritten file is tracked and was clean when the run listed it, so
      // a key from that listing is the first run's, and restores U's build.
      const format = (cmd: string) => `
        export default {
          tasks: {
            format: {
              exec: { command: ${JSON.stringify(cmd)} },
              cache: { inputs: { files: ['a.ts'] }, outputs: { files: ['fmt.log'] } },
            },
            build: {
              dependsOn: ['format'],
              exec: { command: 'mkdir -p dist; cat a.ts > dist/out.txt' },
              cache: { inputs: { files: ['a.ts'], tasks: [] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `
      const app = await addProject(root, 'app', {
        config: format('echo ok > fmt.log'),
        files: { 'a.ts': 'U\n' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\nfmt.log\n')
      commit()
      await runTask('build')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('U\n')

      await writeFile(
        path.join(app, 'vx.config.mjs'),
        format("sed -i.bak 's/U/F/' a.ts && rm a.ts.bak && echo ok > fmt.log"),
      )
      commit()
      const r = await runTask('build')
      expect(statusOf(r, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('F\n')
    },
    TIMEOUT,
  )
})

describe('what a moved task wrote elsewhere is seen too', () => {
  it(
    "a workspace output it created in another project reaches that project's reader",
    async () => {
      // Its save would have marked the output against `app`'s listing; the
      // save is withheld, and the listing must not outlive the write.
      await addProject(root, 'lib', {
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: "sed -i.bak 's/U/F/' a.ts && rm a.ts.bak && printf G > ../app/gen.txt" },
                cache: {
                  inputs: { files: ['a.ts'] },
                  outputs: { files: [], workspaceFiles: ['packages/app/gen.txt'] },
                },
              },
            },
          }
        `,
        files: { 'a.ts': 'U\n' },
      })
      await addProject(root, 'app', {
        deps: { lib: 'workspace:*' },
        config: `
          export default {
            tasks: {
              build: {
                dependsOn: ['^gen'],
                exec: { command: 'mkdir -p dist; cat gen.txt > dist/out.txt' },
                cache: { inputs: { files: ['gen.txt'], tasks: [] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\n')
      commit()
      await runTask('build')
      expect(status.filter((l) => l.includes('app#build'))).toEqual([])
    },
    TIMEOUT,
  )
})

describe('an input the user edits during the run', () => {
  const BUILD = `
    export default {
      tasks: {
        build: {
          exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done; mkdir -p dist; cat src/a.ts > dist/out.js' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
        },
      },
    }
  `

  it(
    'while the command runs: the entry is withheld, and the restored file rebuilds',
    async () => {
      const app = await addProject(root, 'app', { config: BUILD, files: { 'src/a.ts': 'X\n' } })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\nstarted\ngo\n')
      commit()
      const pending = runTask('build')
      await reached(path.join(app, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      await writeFile(path.join(app, 'go'), '')
      await pending
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/src/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it',
      ])

      gitIn(root)('checkout', '--', 'packages/app/src/a.ts')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      const again = await runTask('build')
      // Before the fix: a local hit restoring `EDITED`.
      expect(statusOf(again, 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )

  // `lib#gate` holds the run until the test releases it; `app#build` is
  // after it but keyed up front (another project, no outputs), so the edit
  // lands between the key and the command.
  async function gated(files: Record<string, string>): Promise<{ app: string; lib: string }> {
    const lib = await addProject(root, 'lib', {
      config: `
        export default {
          tasks: { gate: { exec: { command: 'touch started; while [ ! -f go ]; do sleep 0.01; done' } } },
        }
      `,
    })
    const app = await addProject(root, 'app', {
      deps: { lib: 'workspace:*' },
      config: `
        export default {
          tasks: {
            build: {
              dependsOn: ['^gate'],
              exec: { command: 'mkdir -p dist; cat src/a.ts > dist/out.js' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }
      `,
      files,
    })
    await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\nstarted\ngo\n')
    return { app, lib }
  }

  it(
    'before the task starts, a TRACKED input: its index OID is not trusted past the edit',
    async () => {
      const { app, lib } = await gated({ 'src/a.ts': 'X\n' })
      commit()
      const pending = runTask('build')
      await reached(path.join(lib, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      // Past the racy window: the edit is older than the describe by more
      // than it, so only dating the OID from the enumeration (not from the
      // describe) sends the file to be hashed again.
      await Bun.sleep(FILE_HASH_RACY_MS * 2)
      await writeFile(path.join(lib, 'go'), '')
      await pending
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: `packages/app/src/a.ts` changed after its key was taken — the result stands, but is not saved under a key that no longer describes it',
      ])

      gitIn(root)('checkout', '--', 'packages/app/src/a.ts')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      expect(statusOf(await runTask('build'), 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )

  it(
    'before the task starts, an UNTRACKED input: the key re-derived at the command differs',
    async () => {
      const { app, lib } = await gated({ 'src/b.ts': 'b\n' })
      commit()
      // Untracked: hashed by content, at the up-front key and again at the describe.
      await writeFile(path.join(app, 'src', 'a.ts'), 'X\n')
      const pending = runTask('build')
      await reached(path.join(lib, 'started'))
      await writeFile(path.join(app, 'src', 'a.ts'), 'EDITED\n')
      // Past the racy window, so the file's ctime clears the describe's fact
      // and the post-command re-check alone would pass: this row holds the
      // comparison of the two keys.
      await Bun.sleep(FILE_HASH_RACY_MS * 2)
      await writeFile(path.join(lib, 'go'), '')
      await pending
      expect(status.filter((l) => MOVED.test(l))).toEqual([
        '[vx] app#build: its inputs changed after its key was taken — the result stands, but is not saved under a key that no longer describes it',
      ])

      await writeFile(path.join(app, 'src', 'a.ts'), 'X\n')
      await rm(path.join(app, 'dist'), { recursive: true, force: true })
      expect(statusOf(await runTask('build'), 'app#build')).toBe('success')
      expect(await readFile(path.join(app, 'dist', 'out.js'), 'utf8')).toBe('X\n')
    },
    TIMEOUT,
  )
})

describe('control: inputs an upstream wrote just before are not a move', () => {
  it(
    'a codegen consumer is saved on its first run and hits on its second',
    async () => {
      // `gen` writes the consumer's input milliseconds before the consumer's
      // key: inside the racy window, so the re-check hashes it — and finds
      // the digest the key folded.
      await addProject(root, 'app', {
        config: `
          export default {
            tasks: {
              gen: {
                exec: { command: 'printf generated > gen.txt' },
                cache: { inputs: { files: ['src/**'] }, outputs: { files: ['gen.txt'] } },
              },
              build: {
                dependsOn: ['gen'],
                exec: { command: 'mkdir -p dist; cat gen.txt > dist/out.txt' },
                cache: { inputs: { files: ['src/**', 'gen.txt'] }, outputs: { files: ['dist/**'] } },
              },
            },
          }
        `,
        files: { 'src/a.txt': 'a' },
      })
      await writeFile(path.join(root, '.gitignore'), '.vx/\ndist/\n')
      commit()
      await runTask('build')
      expect(status.filter((l) => MOVED.test(l))).toEqual([])
      expect(statusOf(await runTask('build'), 'app#build')).toBe('cache-hit')
    },
    TIMEOUT,
  )
})

describe('movedInput — which files the re-check hashes again', () => {
  /** A cache whose `hashFile` records each call and answers `digest`. */
  const counting = (digest: string): { cache: CacheLayer; calls: string[] } => {
    const calls: string[] = []
    const cache = {
      hashFile: async (p: string) => {
        calls.push(p)
        return digest
      },
    } as unknown as CacheLayer
    return { cache, calls }
  }

  it('a file last changed well before its fact is not read at all', async () => {
    const f = path.join(root, 'old.txt')
    await writeFile(f, 'x')
    const ctime = lstatSync(f).ctimeMs
    const { cache, calls } = counting('d')
    const facts = [{ path: f, digest: 'OTHER', since: ctime + FILE_HASH_RACY_MS * 4 }]
    expect(await movedInput(facts, cache)).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('one changed inside the racy window BEFORE its fact is read again, as git reads its index', async () => {
    // A coarse clock stamps a write just after the fact with a time just
    // before it; the window is what catches that write.
    const f = path.join(root, 'racy.txt')
    await writeFile(f, 'x')
    const ctime = lstatSync(f).ctimeMs
    const same = counting('d')
    expect(
      await movedInput(
        [{ path: f, digest: 'd', since: ctime + FILE_HASH_RACY_MS / 2 }],
        same.cache,
      ),
    ).toBeUndefined()
    expect(same.calls).toEqual([f])
    const other = counting('e')
    expect(
      await movedInput(
        [{ path: f, digest: 'd', since: ctime + FILE_HASH_RACY_MS / 2 }],
        other.cache,
      ),
    ).toBe(f)
  })

  it('a file that is gone has moved, and nothing is read', async () => {
    const { cache, calls } = counting('d')
    const gone = path.join(root, 'gone.txt')
    expect(await movedInput([{ path: gone, digest: 'd', since: 0 }], cache)).toBe(gone)
    expect(calls).toEqual([])
  })
})

describe('describeTaskInputs dates each fact from where it was learned', () => {
  it(
    'an index OID from the enumeration start, a hashed file from the describe, package.json from the enumeration',
    async () => {
      const dir = await addProject(root, 'app', { files: { 'tracked.txt': 't' } })
      commit()
      await writeFile(path.join(dir, 'untracked.txt'), 'u')
      const before = Date.now()
      const git = new GitFilesCache()
      applyGitEnumeration(await startGitEnumeration(root, ['.']), root, [dir], git)
      const after = Date.now()
      expect(git.enumeratedAtMs).toBeGreaterThanOrEqual(before)
      expect(git.enumeratedAtMs).toBeLessThanOrEqual(after)
      // Later than the enumeration by more than any clock step between them.
      await Bun.sleep(5)
      const cache = new Cache(path.join(root, '.vx', 'cache'))
      try {
        const described = await describeTaskInputs({
          node: {
            id: 'app#t',
            projectName: 'app',
            projectDir: dir,
            taskName: 't',
            config: {
              exec: { command: 'true' },
              cache: { inputs: { files: ['*.txt'] }, outputs: { files: [] } },
            },
            deps: [],
            requested: true,
          } as TaskNode,
          upstream: [],
          workspaceRoot: root,
          workspaceFingerprint: 'fp',
          cache,
          nestedProjectDirs: [],
          gitFilesCache: git,
        })
        const since = Object.fromEntries(
          described.facts.map((f) => [path.relative(dir, f.path), f.since]),
        )
        expect(Object.keys(since).sort()).toEqual(['package.json', 'tracked.txt', 'untracked.txt'])
        expect(since['tracked.txt']).toBe(git.enumeratedAtMs!)
        expect(since['package.json']).toBe(git.enumeratedAtMs!)
        expect(since['untracked.txt']).toBeGreaterThan(git.enumeratedAtMs!)
      } finally {
        cache.close()
      }
    },
    TIMEOUT,
  )
})
