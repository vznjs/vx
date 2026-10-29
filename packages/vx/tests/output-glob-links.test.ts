// Edge cases where what the output walk takes, what the clean deletes and
// what the temp sweep touches disagreed with the rules they share: project
// boundaries are hard, links out of the project are never followed for a
// delete, and a committed file is never deleted.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { cleanOutputs, resolveOutputs } from '../src/cache/inputs.js'
import { relPosix } from '../src/util/index.js'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'vx-glob-links-'))
  made.push(d)
  return d
}

it("a link at an output's head into a nested project is not this project's output", async () => {
  // The walk follows a head link that stays in the project (X-88), but the
  // nested-project filter read the lexical `docs/...`: the clean deleted the
  // site's untracked build and the save packed it into the parent's entry.
  const d = tmp()
  mkdirSync(path.join(d, 'packages/site/dist'), { recursive: true })
  writeFileSync(path.join(d, 'packages/site/dist/index.html'), 'x')
  symlinkSync('packages/site/dist', path.join(d, 'docs'))
  const args = {
    projectDir: d,
    outputs: ['docs/**'],
    nestedProjectDirs: [path.join(d, 'packages/site')],
  }
  expect(await resolveOutputs(args)).toEqual([])
  await cleanOutputs({ ...args, committed: () => false })
  expect(existsSync(path.join(d, 'packages/site/dist/index.html'))).toBe(true)
})

it('the restore-temp sweep never reaches through a link out of the project', async () => {
  // It ran before the link refusal, so a file named like a temp outside the
  // project was gone before the clean refused the link.
  const d = tmp()
  const outside = tmp()
  writeFileSync(path.join(outside, '.vx-tmp-zzzzz-1'), 'theirs')
  symlinkSync(outside, path.join(d, 'out'))
  await cleanOutputs({
    projectDir: d,
    outputs: ['out/a.txt'],
    nestedProjectDirs: [],
    committed: () => false,
  }).catch(() => undefined)
  expect(existsSync(path.join(outside, '.vx-tmp-zzzzz-1'))).toBe(true)
})

it('the restore-temp sweep spares a committed file named like a temp', async () => {
  const d = tmp()
  mkdirSync(path.join(d, 'out'))
  writeFileSync(path.join(d, 'out/.vx-tmp-zzzzz-1'), 'mine')
  await cleanOutputs({
    projectDir: d,
    outputs: ['out/a.txt'],
    nestedProjectDirs: [],
    committed: () => true,
  })
  expect(existsSync(path.join(d, 'out/.vx-tmp-zzzzz-1'))).toBe(true)
})

it('a linked output head is walked the same beside a ** glob', async () => {
  // A leading `**` turns the list into one walk that does not follow links,
  // so `dist -> build` beside `**/*.tsbuildinfo` saved an empty entry.
  const d = tmp()
  mkdirSync(path.join(d, 'build'))
  writeFileSync(path.join(d, 'build/a.js'), 'x')
  symlinkSync('build', path.join(d, 'dist'))
  const rel = (fs: string[]) => fs.map((f) => relPosix(d, f))
  const one = await resolveOutputs({ projectDir: d, outputs: ['dist/**'], nestedProjectDirs: [] })
  const two = await resolveOutputs({
    projectDir: d,
    outputs: ['dist/**', '**/*.tsbuildinfo'],
    nestedProjectDirs: [],
  })
  expect(rel(one)).toEqual(['dist/a.js'])
  expect(rel(two)).toEqual(rel(one))
})

it('an escaped literal output directory is pruned like a plain one', async () => {
  // `out/\[x\]` names one path (a Next.js route dir), but the prune scope
  // read the `\` as a wildcard and left the emptied directory, which then
  // blocks a restore that holds a file there.
  const d = tmp()
  for (const n of ['x', '[x]']) {
    mkdirSync(path.join(d, 'out', n), { recursive: true })
    writeFileSync(path.join(d, 'out', n, 'f'), '1')
  }
  await cleanOutputs({
    projectDir: d,
    outputs: ['out/x', 'out/\\[x\\]'],
    nestedProjectDirs: [],
    committed: () => false,
  })
  expect(existsSync(path.join(d, 'out/x'))).toBe(false)
  expect(existsSync(path.join(d, 'out/[x]'))).toBe(false)
})
