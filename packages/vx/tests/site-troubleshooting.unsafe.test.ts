// The Troubleshooting page quotes what vx prints. Each quoted message's
// literal parts (split at `…`) must appear in core's source, or the page
// names an error a reader will never see.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const PAGE = path.resolve(
  import.meta.dir,
  '../../vx-docs/src/content/docs/guides/troubleshooting.md',
)
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

describe('the Troubleshooting page quotes vx as it prints', () => {
  it('every quoted error is in core’s source', () => {
    const page = readFileSync(PAGE, 'utf8')
    const at = page.indexOf('## vx printed an error')
    const table = page.slice(at, page.indexOf('\n## ', at + 1))
    const quoted = [...table.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]!)
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
})
