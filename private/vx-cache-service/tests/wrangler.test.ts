import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

// A Preview inherits no production setting: a PR's run reads the Preview
// (README), so an ALLOW or bucket that drifts from production's refuses
// that run's token or reads another bucket.
it('gives a Preview the production ALLOW and bucket', () => {
  const file = path.resolve(import.meta.dir, '..', 'wrangler.jsonc')
  const cfg = Bun.JSONC.parse(readFileSync(file, 'utf8')) as {
    vars: Record<string, string>
    r2_buckets: unknown
    previews: { vars: Record<string, string>; r2_buckets: unknown }
  }
  expect(cfg.previews.vars).toEqual(cfg.vars)
  expect(cfg.previews.r2_buckets).toEqual(cfg.r2_buckets)
})
