// When the git enumeration may trust an index OID for a file, end to end:
// each row is a working tree git reports in a shape the trust rule once
// misread, and the run that followed replayed stale bytes under a green
// run. The rule itself is in `src/cache/git-inputs.ts`.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Logger, RunSummary } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const TIMEOUT = 30_000

let root: string

const logger: Logger = {
  status: () => {},
  taskStdout: () => {},
  taskStderr: () => {},
  taskComplete: () => {},
}

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-git-trust-' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function cli(): void {
  const r = Bun.spawnSync([process.execPath, BIN, 'run', 'build', '--all'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`vx run: ${r.stderr.toString()}${r.stdout.toString()}`)
}

async function build(): Promise<string | undefined> {
  const r: RunSummary = await run({ cwd: root, tasks: ['build'], log: logger })
  expect(r.ok).toBe(true)
  return r.outcomes.find((o) => o.node.id === 'a#build')?.status
}

describe('a rename git reports in the second status column', () => {
  it(
    'a deleted rename source is not an input (item 976)',
    async () => {
      // `git add -N` on the copy, then the original removed: porcelain v1
      // prints ` R new.txt\0old.txt\0`, the rename in Y. The parser took
      // the source token only for an R or C in X, so `old.txt` read as a
      // record of its own, stayed trusted, and was keyed from the index
      // though it was gone.
      const dir = await addProject(root, 'a', {
        config: `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && ls *.txt > dist/out' },
              cache: { inputs: { files: ['*.txt'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      })
      await writeFile(path.join(dir, 'old.txt'), 'x\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      await writeFile(path.join(dir, 'new.txt'), 'x\n')
      git('add', '-N', path.join(dir, 'new.txt'))

      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toBe('new.txt\nold.txt\n')

      await rm(path.join(dir, 'old.txt'))
      const porcelain = git('status', '--porcelain', '-z', '--', dir)
      expect(porcelain).toContain(' R ')
      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toBe('new.txt\n')
    },
    TIMEOUT,
  )
})

describe('a .gitattributes the index does not hold as clean', () => {
  const CONFIG = `export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cat src.txt > dist/out.txt' },
        cache: { inputs: { files: ['*.txt'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }`

  // `*.txt text` normalizes the committed blob to LF while the worktree
  // keeps CRLF; `git status` compares after the filter, so a rewrite to LF
  // reads clean and the index OID is the same for both. The gate that
  // stops trusting such an OID looked for `.gitattributes` among the
  // TRUSTED paths only, so one untracked or modified was never seen, and
  // the rewrite replayed the CRLF output (item 977).
  async function crlfThenLf(attributes: 'untracked' | 'modified'): Promise<string> {
    const dir = await addProject(root, 'a', { config: CONFIG })
    const git = gitIn(root)
    if (attributes === 'modified') {
      await writeFile(path.join(dir, '.gitattributes'), '# none yet\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'attributes')
    }
    await writeFile(path.join(dir, '.gitattributes'), '*.txt text\n')
    await writeFile(path.join(dir, 'src.txt'), 'a\r\nb\r\n')
    git(
      'add',
      path.join(dir, 'src.txt'),
      path.join(dir, 'vx.config.mjs'),
      path.join(dir, 'package.json'),
    )
    git('commit', '-q', '-m', 'fixture')
    expect(git('status', '--porcelain', '--', path.join(dir, 'src.txt'))).toBe('')

    // The CLI, one process per run, as a user runs it. Two `run()` calls in
    // one process derived the same key here and still re-executed the
    // second time (why is not yet known), so they could not see the hit.
    cli()
    await writeFile(path.join(dir, 'src.txt'), 'a\nb\n')
    cli()
    return readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')
  }

  it(
    'an untracked one still stops the index OID keying a converted file (item 977)',
    async () => {
      expect(await crlfThenLf('untracked')).toBe('a\nb\n')
    },
    TIMEOUT,
  )

  it(
    'a modified one does too (item 977)',
    async () => {
      expect(await crlfThenLf('modified')).toBe('a\nb\n')
    },
    TIMEOUT,
  )
})

describe('a clean filter driver', () => {
  it(
    'a filter= driver stops the index OID keying the file (item 978)',
    async () => {
      // `filter=strip` with a clean command that drops comment lines: `#A`
      // and `#B` versions of the file clean to one blob, `git status` calls
      // the edit clean, and the gate asked `check-attr` only for `text`,
      // `eol` and `ident`, so the run replayed `#A`.
      const dir = await addProject(root, 'a', {
        config: `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && head -1 src.txt > dist/out.txt' },
              cache: { inputs: { files: ['*.txt'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      })
      const git = gitIn(root)
      git('config', 'filter.strip.clean', "sed '/^#/d'")
      git('config', 'filter.strip.smudge', 'cat')
      await writeFile(path.join(dir, '.gitattributes'), '*.txt filter=strip\n')
      await writeFile(path.join(dir, 'src.txt'), '#A\ncode\n')
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      cli()
      expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe('#A\n')

      await writeFile(path.join(dir, 'src.txt'), '#B\ncode\n')
      expect(git('status', '--porcelain', '--', path.join(dir, 'src.txt'))).toBe('')
      cli()
      expect(await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')).toBe('#B\n')
    },
    TIMEOUT,
  )

  it(
    'a working-tree-encoding does too (item 978)',
    async () => {
      // UTF-16 with a little-endian BOM, then the same text big-endian:
      // two byte sequences, one UTF-8 blob, and a status that calls the
      // edit clean.
      const dir = await addProject(root, 'a', {
        config: `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && od -An -tx1 src.txt > dist/out.txt' },
              cache: { inputs: { files: ['*.txt'] }, outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      })
      const git = gitIn(root)
      await writeFile(path.join(dir, '.gitattributes'), '*.txt working-tree-encoding=UTF-16\n')
      await writeFile(path.join(dir, 'src.txt'), Buffer.from([0xff, 0xfe, 0x61, 0, 0x0a, 0]))
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      cli()
      const before = await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')

      await writeFile(path.join(dir, 'src.txt'), Buffer.from([0xfe, 0xff, 0, 0x61, 0, 0x0a]))
      expect(git('status', '--porcelain', '--', path.join(dir, 'src.txt'))).toBe('')
      cli()
      const after = await readFile(path.join(dir, 'dist', 'out.txt'), 'utf8')
      expect([before.trim(), after.trim()]).toEqual(['ff fe 61 00 0a 00', 'fe ff 00 61 00 0a'])
    },
    TIMEOUT,
  )
})
