// The filesystem groundwork a bind needs, and what vx leaves behind. bwrap
// cannot bind a path that does not exist, so a write grant is pre-created:
// a literal as an empty file, a glob's prefix or a `dir/` as a directory.
// The file placeholder is vx's until the task writes it — a task that
// meant a directory met "File exists" from its own mkdir and the empty
// file survived every later clean (2026-09-16), so the sweep takes back
// what the task never wrote, and the failure names the `dir/` spelling.

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import {
  sandboxRequestFor,
  sweepPlaceholders,
  untouchedPlaceholderLine,
} from '../src/orchestrator/sandbox-request.js'

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-sandbox-request-'))
  dir = path.join(root, 'proj')
  await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function node(): TaskNode {
  return {
    id: 'proj#build',
    projectName: 'proj',
    projectDir: dir,
    taskName: 'build',
    config: { exec: { command: 'true' } },
    deps: [],
    requested: true,
  }
}

const requestFor = (write: string[]) => sandboxRequestFor(node(), { allow: { write } }, root)

const kind = async (p: string): Promise<'file' | 'dir' | 'none'> => {
  const st = await stat(p).catch(() => undefined)
  return st === undefined ? 'none' : st.isDirectory() ? 'dir' : 'file'
}

describe('a write grant is pre-created for the bind', () => {
  it('a literal names a file: an empty placeholder, reported', async () => {
    const r = await requestFor(['dist/vx'])
    expect(await kind(path.join(dir, 'dist/vx'))).toBe('file')
    expect(r.placeholders.map((p) => p.path)).toEqual([path.join(dir, 'dist/vx')])
  })

  it('a trailing slash names a directory: created, no placeholder', async () => {
    const r = await requestFor(['dist/'])
    expect(await kind(path.join(dir, 'dist'))).toBe('dir')
    expect(r.placeholders).toEqual([])
  })

  it('a glob names its static prefix as a directory', async () => {
    const r = await requestFor(['coverage/**'])
    expect(await kind(path.join(dir, 'coverage'))).toBe('dir')
    expect(r.placeholders).toEqual([])
  })

  it('what is already there is what the task meant: a directory stays one', async () => {
    await mkdir(path.join(dir, 'dist'))
    const r = await requestFor(['dist'])
    expect(await kind(path.join(dir, 'dist'))).toBe('dir')
    expect(r.placeholders).toEqual([])
  })

  it('the request itself is unchanged by the spelling: `dist/` grants `dist`', async () => {
    const slash = await requestFor(['dist/'])
    const plain = await requestFor(['dist'])
    expect(slash.sandbox.config.allowWrite).toEqual(plain.sandbox.config.allowWrite)
  })
})

describe('sweepPlaceholders takes back what the task never wrote', () => {
  it('an untouched placeholder is removed and named', async () => {
    const r = await requestFor(['dist/vx'])
    const untouched = await sweepPlaceholders(r.placeholders)
    expect(untouched).toEqual([path.join(dir, 'dist/vx')])
    expect(await kind(path.join(dir, 'dist/vx'))).toBe('none')
  })

  it('a placeholder the task wrote is its output and stays', async () => {
    const r = await requestFor(['dist/vx'])
    await writeFile(path.join(dir, 'dist/vx'), 'bytes')
    expect(await sweepPlaceholders(r.placeholders)).toEqual([])
    expect(await kind(path.join(dir, 'dist/vx'))).toBe('file')
  })

  it('a placeholder the task replaced with a directory stays', async () => {
    const r = await requestFor(['dist'])
    await rm(path.join(dir, 'dist'))
    await mkdir(path.join(dir, 'dist'))
    expect(await sweepPlaceholders(r.placeholders)).toEqual([])
    expect(await kind(path.join(dir, 'dist'))).toBe('dir')
  })

  it('the hint names the grant as the task spelled it and the directory spelling', () => {
    const line = untouchedPlaceholderLine(dir, path.join(dir, 'dist'))
    expect(line).toContain('write grant `dist` named nothing on disk')
    expect(line).toContain('spell the grant `dist/`')
  })
})
