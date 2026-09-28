// A PR's title and every commit it adds are Conventional Commits headers
// (scripts/conventional.ts): the repo rebase-merges, so each commit subject
// lands on main as written, and the release notes and version read them.
// CI's PR runs pass the title and the PR's base and head; a push to main
// (already checked as a PR) and a local gate pass none, and the rows have
// nothing to judge there.
//
// `.unsafe`: it asks git for the PR's commits, and a sandboxed shard has no git.
import path from 'node:path'
import { expect, it } from 'bun:test'
import { conventionalError } from '../scripts/conventional.js'

const title = process.env['VX_PR_TITLE'] ?? ''
const base = process.env['VX_PR_BASE'] ?? ''
const head = process.env['VX_PR_HEAD'] ?? ''

it("the PR's title is a Conventional Commits header", () => {
  if (title === '') return
  expect(conventionalError(title)).toBeNull()
})

it('every commit the PR adds has a Conventional Commits subject', () => {
  if (base === '' || head === '') return
  const r = Bun.spawnSync(['git', 'log', '--no-merges', '--format=%h %s', `${base}..${head}`], {
    cwd: path.resolve(import.meta.dir, '..'),
  })
  expect(r.exitCode).toBe(0)
  const bad = r.stdout
    .toString()
    .split('\n')
    .filter((l) => l !== '')
    .flatMap((l) => {
      const subject = l.slice(l.indexOf(' ') + 1)
      const why = conventionalError(subject)
      return why === null ? [] : [`${l}: ${why}`]
    })
  expect(bad).toEqual([])
})
