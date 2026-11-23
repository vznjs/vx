// Every vx verb has its own page under /cli/ and a sidebar link to it,
// so the reference packages/vx/tests/cli-flags-explained.test.ts holds
// (each verb's section, each flag explained, real coloured output) is
// one click from the Docs sidebar.
import { expect, it } from 'bun:test'
import { CORE_VERBS } from '../../../packages/vx/src/util/index.js'
import { SPLIT_REFERENCES } from '../scripts/import-docs.js'
import { SIDEBAR } from '../src/nav/sections.js'

const cli = SPLIT_REFERENCES.find((r) => r.src === 'cli.md')!

const pageOf = (verb: string): string | undefined =>
  cli.specs.find((s) =>
    s.headings.some((h) => h === `\`vx ${verb}\`` || h.startsWith(`\`vx ${verb} `)),
  )?.page

it('every verb has a /cli/ page', () => {
  expect(CORE_VERBS.filter((v) => pageOf(v) === undefined)).toEqual([])
})

it('every verb page is in the sidebar', () => {
  const links = JSON.stringify(SIDEBAR)
  const missing = CORE_VERBS.filter((v) => !links.includes(`"/cli/${pageOf(v)}/"`))
  expect(missing).toEqual([])
})
