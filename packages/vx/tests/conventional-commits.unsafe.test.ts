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
  // #5251's old-core fix for vx-history, pushed before its subject was cut: 76 chars.
  '3a50a99503149449d51d3c073a798259e9b30af4',
  // #5222's package-graph doc fix, pushed before its subject was cut: 77 chars.
  '448d9031eeff318573375251311ab8dcd5a09ec7',
  // The worker-bytes paragraph split, pushed with its body line as the subject.
  '028652fd3d3f00b7b7bd95678edfcd6ae7d81f83',
  // The retry committed-output fix, pushed before its subject was cut: 73 chars.
  '843709e7f54a865711beb4c145511720f367feb8',
  // The read-only plugin views' commit, pushed before its subject was cut: 73 chars.
  '0e2d40c8471e028a28719f1522bd48d08c037729',
  // The CLI verb fixes' commit, pushed before its subject was cut: 72 chars.
  '787cd2e8f4d87f875e961983aff1f5c09aaa61c1',
  // #5123's migrate stale-hit fix, pushed before its subject was cut: 74 chars.
  '2eee96a62fd9218431f3105a7d26e6249b88993e',
  // #5113's v54 doc pins, pushed before its subject was cut: 74 chars.
  '02a96fb35f0ec5ea898976f571e9d6afec16f965',
  // #5044's dead-source-glob commit, pushed before its subject was cut: 74 chars.
  '0c01008f271ea5a2b11225131eb907a2a11e712e',
  // #5044's site troubleshooting quote fix: 73 chars.
  '42f6dd13749cac4897a212cca02e69082c8e5fd6',
  // #5044's vx why pointer fix: 75 chars.
  '652a7e6686a0ec53ceee50e8b2644ae2e80e8c02',
  // The conformance page's coverage drop, pushed before its subject was cut: 76 chars.
  '07826d51a0d3c97cfe85b518c92635ada75560c7',
  // #4909's first commit, pushed before its subject was cut: 82 chars.
  'c06443abb95ae880949aa349802eaade1c58b144',
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
  // The task-load gate's, pushed before its subject was cut: 72 chars.
  '8c5d2cb4612c61737de9937b997e99faf5f190b1',
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
  // #4893's, pushed with `style`, a type the row does not take; the branch takes no force push.
  '67926096fc590900362a8b9096ad6b005b33bd60',
  // #4906's, pushed before the row ran on it: 72 chars; the branch takes no force push.
  '29647776ab6b220eafe7ab18ffefde5ea22e5391',
  // #4927's, 72 chars; the branch takes no force push.
  'a451b5d4095c420400082fc8443e637706562f04',
  // #4933's, 76 chars; the branch takes no force push.
  '117c2316c067b309be0b5a2df0ba2b8a7c671c78',
  // #4943's, 73 chars, closed; its commits ride the branch, which takes no force push.
  '0b824af206d900ff321fe01b4e26614431598165',
  // #4944's, 73 chars; the branch takes no force push.
  '010ceaec9459d1ab5133486a008076a61c0be18d',
  // #4954's, 72 chars; the branch takes no force push.
  'c92c5272220be7ce8b3371e485948819e3b5a6d8',
  // #4988's, 72 chars; the branch takes no force push.
  'ee28e8170e812e6596777ce3e0ddcdbe8b8a8af3',
  // #5048's, 72 chars; the branch takes no force push.
  '3cec53022bde9f3c63592509a1f2ee6b60087acd',
  // #5048's, 78 chars; the branch takes no force push.
  '62e8ba1558da069b7e201a43de7a8f577c61f6ad',
  // #5050's, 72 chars; the branch takes no force push.
  'ac67d49d0182a5d066ef79be5cbe664d8d18f21d',
  // #5050's, 75 chars; the branch takes no force push.
  '11bada098e010efa3031faae4a5458d2724f59ed',
  // #5049's, 72 chars; the branch takes no force push.
  '0264bf0118d8c77550f1b764bb345dc5ba2d9dbf',
  // #5067's, 73 chars; the branch takes no force push.
  'f1d846e6c771f173a2614587a83b502c0b98fe4d',
  // #5078's, 72 chars; the branch takes no force push.
  '86c8e5262993ad10ada2e65b5ebde7f5f098b4f6',
  // #5104's, type style; the branch takes no force push.
  'a44b8b967f2da77043670c960504325915286cf4',
  // #5065's three `wip` commits; the branch takes no force push.
  'bea041bc4005450e12f902bcf9d8b5234532f89f',
  '62b13c98e22d6ac9b9ee41fa9a8ce3a1df406c37',
  '81d3b6f52424a708d4bc4863f4f28b8506eca215',
  // #5151's, 72 chars; the branch takes no force push.
  '7effceb8134385018f9cd443d0dfeedd05c4c607',
  // #5151's ctime-message fix, 72 chars; pushed before its subject was cut.
  '8f3c5a2fc288f1b2c75023e09e694117676c86bb',
  // #5183's, type style; the branch takes no force push.
  '1d6cc432ed9b6eae38b0e31563eb392e89545ea1',
  // #5268's, 73 chars; streams build on the branch, which takes no force push.
  '1d00aa32c5141e5f967eb2e382f2e32973eabe71',
  // #5302's, 72 chars; the branch takes no force push.
  'be261c174923428476c00fea31189afde114865a',
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
