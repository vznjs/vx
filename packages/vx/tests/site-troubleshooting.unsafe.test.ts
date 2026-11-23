// Each chapter's "When it goes wrong" block quotes what vx prints (the
// Troubleshooting page's rows, spread over the chapters on 2026-11-23).
// Each quoted message's literal parts (split at `…`) must appear in core's
// source, or the page names an error a reader will never see.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const GUIDES = path.resolve(import.meta.dir, '../../../private/vx-docs/src/content/docs/docs')
const PAGES = ['workspace.mdx', 'tasks.mdx', 'running-tasks.mdx']
const SRC = path.resolve(import.meta.dir, '..', 'src')

function sourceText(dir: string): string {
  let out = ''
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out += sourceText(p)
    else if (e.name.endsWith('.ts')) out += readFileSync(p, 'utf8')
  }
  return out
}

function block(page: string): string {
  const text = readFileSync(path.join(GUIDES, page), 'utf8')
  const m = /title="When it goes wrong">([\s\S]*?)<\/Deeper>/.exec(text)
  expect(m).not.toBeNull()
  return m![1]!
}

describe('the "When it goes wrong" blocks quote vx as it prints', () => {
  it('every quoted error is in core’s source', () => {
    const quoted = PAGES.flatMap((p) => [...block(p).matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]!))
    expect(quoted.length).toBeGreaterThanOrEqual(10)
    const src = sourceText(SRC)
    // The one row a shell prints, not vx.
    const missing = quoted
      .filter((q) => q !== 'vx: command not found')
      .flatMap((q) =>
        q
          .split('…')
          .map((part) => part.replace(/"<key>"/, '').trim())
          .filter((part) => part !== '' && !src.includes(part))
          .map((part) => `${q} → ${part}`),
      )
    expect(missing).toEqual([])
  })

  // A project is a directory with a vx.config (2026-10-14): the
  // J2-38 row (a config with no package.json, skipped) left with the
  // warning, and the refusal a name clash prints took its place.
  it('names the two-projects-one-name refusal and its fix', () => {
    expect(readFileSync(path.join(SRC, 'workspace', 'workspace.ts'), 'utf8')).toContain(
      'two projects are named "',
    )
    const row = block('workspace.mdx')
      .split('\n')
      .find((l) => l.includes('two projects are named'))
    expect(row).toContain('set another `name`')
  })
})
