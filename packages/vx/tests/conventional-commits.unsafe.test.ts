// A PR's title and every commit it adds are Conventional Commits headers
// (scripts/conventional.ts): the repo squash-merges, so main's subject is the
// title and its body the commits', and the release notes and version read them.
// CI's PR runs pass the title and the PR's base and head; a push to main
// (already checked as a PR) and a local gate pass none, and the rows have
// nothing to judge there.
//
// `.unsafe`: it asks git for the PR's commits, and a sandboxed shard has no git.
import path from 'node:path'
import { expect, it } from 'bun:test'
import {
  conventionalError,
  landedHeads,
  landsByMerge,
  squashBreakingError,
} from '../scripts/conventional.js'
import { commitsBetween } from '../scripts/release-notes.js'
import { fetchHistory } from './helpers/history.js'

const title = process.env['VX_PR_TITLE'] ?? ''
const base = process.env['VX_PR_BASE'] ?? ''
const head = process.env['VX_PR_HEAD'] ?? ''
if (base !== '') fetchHistory(path.resolve(import.meta.dir, '..'))

it("the PR's title is a Conventional Commits header", () => {
  if (title === '') return
  expect(conventionalError(title)).toBeNull()
})

// A mega branch's own commit made before this row knew mega branches; its
// subject cannot change without rewriting the branch every landed PR
// shares (2026-10-28).
const KNOWN = new Set(['92f8f4136'])

it('every commit the PR adds has a Conventional Commits subject', () => {
  if (base === '' || head === '') return
  const cwd = path.resolve(import.meta.dir, '..')
  // A PR a mega branch lands was held to this row in its own run, its
  // squash title standing for its commits: only the branch's own are judged.
  const landed = landedHeads(base, head, cwd)
  const r = Bun.spawnSync(
    [
      'git',
      'log',
      '--no-merges',
      '--format=%h %s',
      `${base}..${head}`,
      ...landed.map((h) => `^${h}`),
    ],
    { cwd },
  )
  expect(r.exitCode).toBe(0)
  const bad = r.stdout
    .toString()
    .split('\n')
    .filter((l) => l !== '' && !KNOWN.has(l.slice(0, l.indexOf(' '))))
    .flatMap((l) => {
      const subject = l.slice(l.indexOf(' ') + 1)
      const why = conventionalError(subject)
      return why === null ? [] : [`${l}: ${why}`]
    })
  expect(bad).toEqual([])
})

it('the squash lands as many breaking commits as the branch holds', () => {
  if (title === '' || base === '' || head === '') return
  if (landsByMerge(base, head, path.resolve(import.meta.dir, '..'))) return
  const commits = commitsBetween(base, head, path.resolve(import.meta.dir, '..'))
  expect(squashBreakingError(title, commits)).toBeNull()
})
