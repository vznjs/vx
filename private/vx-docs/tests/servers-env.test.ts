// The servers page's `.env` beside its compose.yaml: each server refuses to
// start without some settings, and the page's file left the cache's S3 keys
// out, so a reader who copied it got a cache that exited at once
// ("S3: Missing S3 credentials").
import path from 'node:path'
import { expect, it } from 'bun:test'

const PAGE = path.join(import.meta.dir, '../src/content/docs/docs/servers/index.mdx')

/** What each server's bun.ts refuses to start without, under compose.yaml's prefixes. */
const REQUIRED = [
  'DTE_ALLOW',
  'DTE_AUDIENCE',
  'CACHE_ALLOW',
  'CACHE_AUDIENCE',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'HISTORY_ALLOW',
  'HISTORY_AUDIENCE',
]

it('sets in its .env every setting a server will not start without', async () => {
  const page = await Bun.file(PAGE).text()
  const env = /```ini title="\.env"\n([\s\S]*?)```/.exec(page)
  expect(env).not.toBeNull()
  const names = [...env![1]!.matchAll(/^([A-Z_0-9]+)=/gm)].map((m) => m[1])
  expect(REQUIRED.filter((n) => !names.includes(n))).toEqual([])
})
