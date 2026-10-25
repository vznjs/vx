import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

// A Preview inherits no production setting.
it('gives a Preview the production ALLOW and binding', () => {
  const file = path.resolve(import.meta.dir, '..', 'wrangler.jsonc')
  const cfg = Bun.JSONC.parse(readFileSync(file, 'utf8')) as {
    vars: Record<string, string>
    durable_objects: unknown
    previews: { vars: Record<string, string>; durable_objects: unknown }
  }
  expect(cfg.previews.vars['ALLOW']).toBe(cfg.vars['ALLOW']!)
  expect(cfg.previews.durable_objects).toEqual(cfg.durable_objects)
})
