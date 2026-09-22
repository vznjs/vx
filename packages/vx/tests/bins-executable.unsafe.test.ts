// Every bin a package declares is executable in git and starts with a
// shebang. npm sets the bit on install, so a published bin works either
// way; a workspace link or a checkout does not, and `@vzn/vx-migrate`'s
// own bin sat at 100644 from its first commit until item 604 — the shim
// `bun link` writes would have failed with EACCES. Unsafe: it reads every
// package and the index.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const repo = path.resolve(import.meta.dir, '..', '..', '..')

function bins(): { pkg: string; rel: string }[] {
  const out: { pkg: string; rel: string }[] = []
  for (const dir of readdirSync(path.join(repo, 'packages'))) {
    const file = path.join(repo, 'packages', dir, 'package.json')
    let json: { name?: string; bin?: unknown }
    try {
      json = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; bin?: unknown }
    } catch {
      continue
    }
    const bin = json.bin
    const entries =
      typeof bin === 'string'
        ? [bin]
        : bin && typeof bin === 'object'
          ? Object.values(bin as Record<string, string>)
          : []
    for (const rel of entries)
      out.push({ pkg: json.name ?? dir, rel: path.join('packages', dir, rel) })
  }
  return out
}

describe('every declared bin is executable', () => {
  const all = bins()
  it('finds the bins by their package.json entries — and there are some', () => {
    expect(all.length).toBeGreaterThan(2)
  })
  it('is mode 100755 in the index and starts with a shebang', () => {
    const wrong: string[] = []
    for (const { pkg, rel } of all) {
      const ls = Bun.spawnSync(['git', 'ls-files', '-s', '--', rel], { cwd: repo })
      const mode = ls.stdout.toString().trim().split(/\s+/)[0]
      const head = readFileSync(path.join(repo, rel), 'utf8').slice(0, 2)
      if (mode !== '100755' || head !== '#!')
        wrong.push(`${pkg}: ${rel} (mode ${mode ?? 'untracked'}, starts ${JSON.stringify(head)})`)
    }
    expect(wrong).toEqual([])
  })
})
