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
const KNOWN = new Set([
  '92f8f41369c5c8ebe41934bb31c8eeddda32b1a1',
  // The second mega branch's, made before the row held it: `style`, a type the row does not take.
  '9f41d72685a623eccfff8dd8a49dda186e273029',
  // The second mega branch's, made before the row held it: 73 chars.
  'c5358fbd580ce677ea0a3c8a6a73f2930ab57cfc',
  // The second mega branch's, made before the row held it: 73 chars.
  'eb5d140c535e81a10e0866f130481efd96bc2aaa',
  // The second mega branch's, made before the row held it: 72 chars.
  '19f7794f03db4adcab11bf4c63b9be304710765b',
  // The second mega branch's, made before the row held it: 74 chars.
  '03b5f2b96e21e06835e47d3a5d64a01c56fac53b',
  // The second mega branch's, made before the row held it: 72 chars.
  'f242774d84b4eb544ae20ee6b21771698b0fa547',
  // The second mega branch's, made before the row held it: 73 chars.
  'e61b3fff6e0f3d450ec219225cca093dd9f4793e',
  // The second mega branch's, made before the row held it: 73 chars.
  'a8df2225a47b612e2ff63cd1831d436b3a926132',
  // The second mega branch's, made before the row held it: 72 chars.
  'a2d4705b49ed44cdf594ba47ed8060eb3d380aae',
  // The third mega branch's, pushed before the row ran on it: 74 chars.
  'fec78038896ceb121683a351eedd9cd9b0cb65a6',
  // The third mega branch's, pushed before the row ran on it: 76 chars.
  'd51dc5aadebfd242b98a2fd82b142ec312415502',
  // The third mega branch's, pushed before the row ran on it: 72 chars.
  '37f3a825a627e6d675318aa96eac671f21441d6f',
  // A turbo pass 2 chunk's, folded before the row ran on it: 74 chars.
  'ff8e78d50c1cfc92f23a000997e0966aa0c0d551',
  // Chunk pA's, folded before the row ran on it: 74 and 72 chars.
  'c4fb2047d4ee0bb68da45db241b0b38ac87fed12',
  '35ccab7810060f0eb477fd68f74b447d8b6c3013',
  // The third mega branch's, pushed before the row ran on it: 72 chars.
  '163e07ec32743c7b8eca637e09c4175d461e7952',
  // The third mega branch's, pushed before the row ran on it: 74 chars.
  'adf8df0351495c9f0c46a53aee2d2fa0bbabc70e',
  // The third mega branch's, pushed before the row ran on it: 72 chars.
  '4879901a4b8894e8c8c08b9f222a86c96eb69958',
  // The third mega branch's, pushed before the row ran on it: 72 chars.
  '50578c5b85f341e79f4b860af185f9430959d000',
  // The third mega branch's, pushed before the row ran on it: 73 chars.
  '52a75ee137857c008f951bff6249f59e454f78a5',
  // The third mega branch's, pushed before the row ran on it: 73 chars.
  'a91621c9fa0979287670970e03c194085cff658c',
])

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
      '--format=%H %s',
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
