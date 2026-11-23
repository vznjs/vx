// Pagefind's backend answers `writeFiles` before its writes land and
// `close()` kills it: a bundle written that way was cut short on a loaded CI
// worker and cached so (src/plugins/release-search.ts). The fake keeps that
// contract; the bundle must still land whole.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'bun:test'
import { RELEASES_BUNDLE, releaseSearch } from '../src/plugins/release-search.ts'

const ENTRY = JSON.stringify({ version: '1.5.2', languages: { en: { page_count: 2 } } })
const files = [
  { path: 'pagefind-entry.json', content: new TextEncoder().encode(ENTRY) },
  { path: 'index/en_1.pf_index', content: new Uint8Array(4096).fill(7) },
]

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('writes the bundle whole though the backend is killed right after it answers', async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'release-search-'))
  const site = `${dir}/`
  const pending: (() => void)[] = []
  const index = {
    addDirectory: async () => ({ errors: [], page_count: 2 }),
    getFiles: async () => ({ errors: [], files }),
    // Answers first; each file gets half its bytes now, the rest later.
    writeFiles: async ({ outputPath }: { outputPath: string }) => {
      for (const f of files) {
        const to = path.join(outputPath, f.path)
        Bun.spawnSync(['mkdir', '-p', path.dirname(to)])
        writeFileSync(to, f.content.subarray(0, f.content.length >> 1))
        pending.push(() => writeFileSync(to, f.content))
      }
      return { errors: [], outputPath }
    },
  }
  const api = {
    createIndex: async () => ({ errors: [], index }),
    // The kill: writes still pending never land.
    close: async () => void pending.splice(0),
  }
  const hook = releaseSearch(api as never).hooks['astro:build:done'] as (
    o: unknown,
  ) => Promise<void>
  await hook({ dir: pathToFileURL(site), logger: { info: () => {} } })
  const entry = readFileSync(path.join(dir, RELEASES_BUNDLE, 'pagefind-entry.json'), 'utf8')
  expect(JSON.parse(entry).languages.en.page_count).toBe(2)
  expect(readFileSync(path.join(dir, RELEASES_BUNDLE, 'index/en_1.pf_index')).length).toBe(4096)
})
