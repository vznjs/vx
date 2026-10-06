// The plugins guide's "Plugins that ship" table names the hooks each
// package fills. `@vzn/vx-migrate`'s row left out `config` and
// `discover`, which turbo() and nx() both fill. Each row is held to the
// hooks its package's factories return (setup/teardown are lifecycle,
// not a hook the table lists).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const PACKAGES = path.resolve(import.meta.dir, '..', '..')
const PAGE = readFileSync(
  path.join(PACKAGES, 'vx-docs', 'src', 'content', 'docs', 'guides', 'plugins.md'),
  'utf8',
)
const FACTORIES: Record<string, string[]> = {
  'vx-reapi': ['reapi'],
  'vx-migrate': ['turbo', 'nx', 'turboCache', 'nxCache'],
  'vx-lockfile': ['pnpm', 'bun', 'npm', 'yarn'],
  'vx-schedule-history': ['scheduleHistoryPlugin'],
  'vx-otel': ['otel'],
  'vx-ci': ['github'],
  'vx-mcp': ['mcp'],
}
const LIFECYCLE = new Set(['name', 'setup', 'teardown'])

describe('the plugins guide lists the hooks each shipped plugin fills', () => {
  it('every row is its factories’ hooks, no more and no fewer', async () => {
    const rows: Record<string, string[]> = {}
    const filled: Record<string, string[]> = {}
    for (const [pkg, names] of Object.entries(FACTORIES)) {
      const row = PAGE.split('\n').find((l) => l.startsWith(`| \`@vzn/${pkg}\``))
      expect(row).toBeDefined()
      const cell = row!.split('|')[2]!.replace(/`[A-Za-z]+\(\)`/g, '')
      rows[pkg] = [...cell.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!).sort()
      const mod = (await import(path.join(PACKAGES, pkg, 'src', 'index.ts'))) as Record<
        string,
        () => Record<string, unknown>
      >
      const hooks = new Set<string>()
      for (const n of names) {
        const plugin = mod[n]!()
        for (const [k, v] of Object.entries(plugin))
          if (v !== undefined && !LIFECYCLE.has(k)) hooks.add(k)
      }
      filled[pkg] = [...hooks].sort()
    }
    expect(rows).toEqual(filled)
  })
})
