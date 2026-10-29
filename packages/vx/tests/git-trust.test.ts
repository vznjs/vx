// When the git enumeration may trust an index OID for a file, end to end:
// each row is a working tree git reports in a shape the trust rule once
// misread, and the run that followed replayed stale bytes under a green
// run. The rule itself is in `src/cache/git-inputs.ts`.

import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GitFilesCache, populateGitFilesCache } from '../src/cache/inputs.js'
import type { RunSummary } from '../src/orchestrator/index.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
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

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

function cli(): void {
  const r = Bun.spawnSync([process.execPath, BIN, 'run', 'build', '--all'], {
    cwd: root,
    // The preload's VX_CACHE_DIR: a spawn with no env saved into ~/.vx.
    env: { ...process.env },
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
              inputs: { files: ['*.txt'] }, cache: { outputs: { files: ['dist/**'] } },
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

describe('a deletion git pairs with an unmerged path', () => {
  it(
    'is not an input (A-59)',
    async () => {
      // `git status` detects renames in the worktree, and a deleted file
      // whose bytes match (≥50 % similar) an unmerged path's worktree file
      // is taken as that path's rename source. Porcelain v1 prints only
      // `UU c.txt` for it, so ` D old.txt` was never printed, `old.txt`
      // stayed trusted, and the run keyed the deleted file from the index:
      // a hit on the output built with it.
      const dir = await addProject(root, 'a', {
        config: `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && ls *.txt > dist/out' },
              inputs: { files: ['*.txt'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      })
      await writeFile(path.join(dir, 'old.txt'), 'x\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      // A conflict (stages 1, 2 and 3) on `c.txt`, its worktree file
      // holding the bytes of `old.txt`, as a merge leaves one mid-resolve.
      const oid = git('hash-object', path.join(dir, 'old.txt')).trim()
      await writeFile(path.join(dir, 'c.txt'), 'x\n')
      const rel = path.relative(root, path.join(dir, 'c.txt'))
      const info = [1, 2, 3].map((s) => `100644 ${oid} ${s}\t${rel}\n`).join('')
      const proc = Bun.spawnSync(['git', 'update-index', '--index-info'], {
        cwd: root,
        stdin: new TextEncoder().encode(info),
      })
      expect(proc.exitCode).toBe(0)

      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toBe('c.txt\nold.txt\n')

      await rm(path.join(dir, 'old.txt'))
      // The shape: git's own status says nothing of the deletion.
      expect(git('status', '--porcelain', '-uno', '--', '.')).toBe(`UU ${rel}\n`)
      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toBe('c.txt\n')
    },
    TIMEOUT,
  )
})

describe('an index blob a filter wrote that no longer applies', () => {
  it(
    'is not trusted for the bytes on disk (A-60)',
    async () => {
      // `git add` under `core.autocrlf=true` stores the LF blob for a CRLF
      // file and records the CRLF file's stat. With the setting gone, git
      // never re-reads the stat-clean file: status calls it clean, the
      // filter gate (today's config and attributes) sees no filter, and the
      // LF blob's OID keyed the CRLF bytes: a hit on the LF build.
      const dir = await addProject(root, 'a', {
        config: `export default {
          tasks: {
            build: {
              exec: { command: 'mkdir -p dist && od -c f.txt > dist/out' },
              inputs: { files: ['*.txt'] }, cache: { outputs: { files: ['dist/**'] } },
            },
          },
        }`,
      })
      const file = path.join(dir, 'f.txt')
      await writeFile(file, 'aa\n')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toContain('a   a  \\n')

      await writeFile(file, 'aa\r\n')
      // Older than the index the add writes, so git holds the entry clean
      // by its stat rather than re-reading it as racy.
      const past = new Date(Date.now() - 10_000)
      await utimes(file, past, past)
      git('-c', 'core.autocrlf=true', 'add', file)
      expect(git('status', '--porcelain', '-uno', '--', '.')).toBe('')
      // The shape: the index still holds the committed LF blob.
      const rel = path.relative(root, file)
      expect(git('ls-files', '-s', file).split(' ')[1]).toBe(git('rev-parse', `HEAD:${rel}`).trim())
      expect(await build()).toBe('success')
      expect(await readFile(path.join(dir, 'dist', 'out'), 'utf8')).toContain('a   a  \\r  \\n')
    },
    TIMEOUT,
  )
})

describe('a .gitattributes the index does not hold as clean', () => {
  const CONFIG = `export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && cat src.txt > dist/out.txt' },
        inputs: { files: ['*.txt'] }, cache: { outputs: { files: ['dist/**'] } },
      },
    },
  }`

  // `*.txt text` normalizes the committed blob to LF while the worktree
  // keeps CRLF; `git status` compares after the filter, so a rewrite to LF
  // reads clean and the index OID is the same for both. The gate that
  // stops trusting such an OID looked for `.gitattributes` among the
  // TRUSTED paths only, so one untracked or modified was never seen, and
  // the rewrite replayed the CRLF output (item 977).
  async function crlfThenLf(attributes: 'untracked' | 'modified' | 'ignored'): Promise<string> {
    const dir = await addProject(root, 'a', { config: CONFIG })
    const git = gitIn(root)
    if (attributes === 'ignored') {
      await writeFile(path.join(dir, '.gitignore'), '.gitattributes\n')
      git('add', path.join(dir, '.gitignore'))
    }
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

    // The CLI, one process per run, as a user runs it. In one process the
    // first run starts within `FILE_HASH_RACY_MS` of the fixture's write, so
    // `movedInput` re-hashes the file after the task, finds the CRLF bytes
    // unlike the LF blob it was keyed by, and saves nothing: the second run
    // re-executed on the same key and could not show the hit (item 982).
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

  it(
    'an ignored one does too: git applies it, and the enumeration never lists it (A-19)',
    async () => {
      expect(await crlfThenLf('ignored')).toBe('a\nb\n')
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
              inputs: { files: ['*.txt'] }, cache: { outputs: { files: ['dist/**'] } },
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
              exec: { command: 'mkdir -p dist && cp src.txt dist/out.bin' },
              inputs: { files: ['*.txt'] }, cache: { outputs: { files: ['dist/**'] } },
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
      const hex = async (): Promise<string> =>
        (await readFile(path.join(dir, 'dist', 'out.bin'))).toString('hex')
      const before = await hex()

      await writeFile(path.join(dir, 'src.txt'), Buffer.from([0xfe, 0xff, 0, 0x61, 0, 0x0a]))
      // One assertion, so a platform whose git answers otherwise (a status
      // that calls the edit dirty) says so beside the bytes.
      const status = git('status', '--porcelain', '--', path.join(dir, 'src.txt'))
      cli()
      expect({ status, before, after: await hex() }).toEqual({
        status: '',
        before: 'fffe61000a00',
        after: 'feff0061000a',
      })
    },
    TIMEOUT,
  )
})

describe('an index written while the enumeration reads it', () => {
  it(
    'an unstage between the listing and the status trusts no OID',
    async () => {
      // `ls-files` and `status` read the index on their own: a `git reset`
      // landing between them (an editor unstaging) paired the OLD index's
      // staged OID with a status of the NEW index, which called the file
      // clean, and the staged blob keyed the committed bytes on disk.
      const dir = await addProject(root, 'a', { files: { 'x.txt': 'one\n' } })
      const x = path.join(dir, 'x.txt')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      await writeFile(x, 'staged\n')
      // No racy entry in either index: `status` reads the real one, not a
      // refreshed copy, and no entry is smudged.
      const past = new Date(Date.now() - 100_000)
      for (const f of git('ls-files', '-z').split('\0').filter(Boolean)) {
        await utimes(path.join(root, f), past, past)
      }
      git('add', '-u')
      await writeFile(x, 'one\n')
      await utimes(x, past, past)
      const shim = path.join(root, '.shim')
      const marker = path.join(shim, 'unstaged')
      const real = Bun.which('git')!
      await mkdir(shim)
      // The listing unstages once it has read the index; the status waits for that.
      await writeFile(
        path.join(shim, 'git'),
        `#!/bin/sh
case "$*" in
  *"ls-files -s -v -z -- "*) '${real}' "$@"; rc=$?; '${real}' reset -q -- packages/a/x.txt; touch '${marker}'; exit $rc ;;
  *" status "*) while [ ! -f '${marker}' ]; do sleep 0.02; done ;;
esac
exec '${real}' "$@"
`,
        { mode: 0o755 },
      )
      const memo = new GitFilesCache()
      const PATH = process.env['PATH']
      process.env['PATH'] = `${shim}${path.delimiter}${PATH ?? ''}`
      try {
        await populateGitFilesCache(root, [dir], memo)
      } finally {
        process.env['PATH'] = PATH
      }
      expect(memo.oidsFor(dir)?.get(path.join(dir, 'x.txt'))).toBeUndefined()
    },
    TIMEOUT,
  )
  it(
    'an add before the blob-size listing (A-60) trusts no OID',
    async () => {
      // The index holds the LF blob `core.autocrlf` wrote for a CRLF file,
      // stat-clean with autocrlf gone: only the blob-size check drops it.
      // An add before that check's own listing rewrote the entry to the
      // CRLF blob, whose size matches, so the check, reading the new
      // index, kept the LF OID the enumeration listed from the old one.
      const dir = await addProject(root, 'a', { files: { 'f.txt': 'aa\n' } })
      const file = path.join(dir, 'f.txt')
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'fixture')
      await writeFile(file, 'aa\r\n')
      const past = new Date(Date.now() - 10_000)
      await utimes(file, past, past)
      git('-c', 'core.autocrlf=true', 'add', file)
      const rel = path.relative(root, file)
      const lf = git('rev-parse', `HEAD:${rel}`).trim()
      expect(git('ls-files', '-s', file).split(' ')[1]).toBe(lf)
      const shim = path.join(root, '.shim')
      const marker = path.join(shim, 'added')
      const real = Bun.which('git')!
      await mkdir(shim)
      // `touch` makes the add re-read the file rather than keep the entry.
      await writeFile(
        path.join(shim, 'git'),
        `#!/bin/sh
case "$*" in
  *" --debug "*) if [ ! -f '${marker}' ]; then touch '${file}' && '${real}' -C '${root}' add '${rel}' || exit 1; : > '${marker}'; fi ;;
esac
exec '${real}' "$@"
`,
        { mode: 0o755 },
      )
      const memo = new GitFilesCache()
      const PATH = process.env['PATH']
      process.env['PATH'] = `${shim}${path.delimiter}${PATH ?? ''}`
      try {
        await populateGitFilesCache(root, [dir], memo)
      } finally {
        process.env['PATH'] = PATH
      }
      expect({
        added: await Bun.file(marker).exists(),
        trusted: memo.oidsFor(dir)?.get(file),
      }).toEqual({
        added: true,
        trusted: undefined,
      })
      // The add stored the CRLF blob: the old OID named other bytes.
      expect(git('ls-files', '-s', file).split(' ')[1]).not.toBe(lf)
    },
    TIMEOUT,
  )
})
