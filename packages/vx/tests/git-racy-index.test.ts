// A fresh checkout writes the index in the second its files were written,
// so every entry is racily clean: git cannot trust their stat and re-hashes
// each file on every `status` until something rewrites the index. vx's
// `status` never writes it (item 880), so in a clone no one else touched
// every run paid the re-hash: 347 ms against 8 ms on react-email's 1,800
// files. The enumeration refreshes a private copy once instead and points
// `status` at it; the real index stays byte for byte as it was.
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { startGitEnumeration } from '../src/cache/index.js'
import { gitInitCommit } from './helpers/workspace.js'

const FILES = 20

let root = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vx-racy-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const gitDir = (): string => path.join(root, '.git')
const indexFile = (): string => path.join(gitDir(), 'index')
const copies = (): string[] => readdirSync(gitDir()).filter((n) => n.startsWith('vx-index-'))

/** Files and index stamped in one second, long enough ago that nothing is in a racy window now. */
function checkout(racy: boolean): void {
  const at = new Date(Math.floor(Date.now() / 1000) * 1000 - 100_000)
  for (let i = 0; i < FILES; i++) {
    const file = path.join(root, `f${i}.txt`)
    writeFileSync(file, `${i}\n`)
    utimesSync(file, at, at)
  }
  gitInitCommit(root, 'init')
  if (racy) utimesSync(indexFile(), at, at)
}

describe('a racily clean index', () => {
  it('is refreshed once, in a private copy, and the real index is left alone', async () => {
    checkout(true)
    const before = readFileSync(indexFile())
    const { mtimeMs } = statSync(indexFile())
    const first = await startGitEnumeration(root, ['.'])
    expect(first.dirty).toBe(false)
    expect(first.trusted.size).toBe(FILES)
    expect(readFileSync(indexFile()).equals(before)).toBe(true)
    expect(statSync(indexFile()).mtimeMs).toBe(mtimeMs)
    const made = copies()
    expect(made).toHaveLength(1)
    const copy = path.join(gitDir(), made[0]!)
    // Refreshed: written after its files, so no entry is racy any more.
    expect(statSync(copy).mtimeMs).toBeGreaterThan(mtimeMs + 1000)
    const { ino } = statSync(copy)
    await startGitEnumeration(root, ['.'])
    expect(copies()).toEqual(made)
    expect(statSync(copy).ino).toBe(ino)
  })

  // The edit keeps the size and the mtime, and its ctime lands in the
  // second the index recorded: only git's racy rule, which the copy keeps by
  // keeping the real index's mtime until git refreshes it, sees it.
  it('still sees a same-size edit made before the refresh', async () => {
    checkout(true)
    const file = path.join(root, 'f3.txt')
    const { mtime } = statSync(file)
    writeFileSync(file, 'x\n')
    utimesSync(file, mtime, mtime)
    const first = await startGitEnumeration(root, ['.'])
    expect(copies()).toHaveLength(1)
    expect(first.changed).toEqual(['f3.txt'])
    expect(first.trusted.has('f3.txt')).toBe(false)
    const next = await startGitEnumeration(root, ['.'])
    expect(next.changed).toEqual(['f3.txt'])
  })

  it('a clean index gets no copy', async () => {
    checkout(false)
    await startGitEnumeration(root, ['.'])
    expect(copies()).toEqual([])
  })
})
