// The READMEs a reader lands on first — the root one, CONTRIBUTING, each
// package's and each starter's — sit outside docs/, so neither the site's
// built-link row nor doc-references' prose row reads them. Each relative
// link, and each `github.com/vznjs/vx/(tree|blob)/main/<path>` link, must
// name a file in this checkout; a `#anchor` into a Markdown file, one of its
// headings as GitHub renders the id. Fenced code is skipped (a sample post
// in vx-docs' README links relative to its own future URL).
//
// `.unsafe`: it reads every package and examples/, which a sandboxed task
// cannot.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..', '..', '..')

function readmes(): string[] {
  const out = ['README.md', 'CONTRIBUTING.md']
  for (const dir of ['packages', 'examples'])
    for (const name of readdirSync(path.join(ROOT, dir)))
      if (existsSync(path.join(ROOT, dir, name, 'README.md'))) out.push(`${dir}/${name}/README.md`)
  return out.filter((f) => existsSync(path.join(ROOT, f)))
}

/** GitHub's heading id: lowercased, punctuation but `-` and `_` dropped, spaces to `-`. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

function headings(file: string): Set<string> {
  const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '')
  return new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map((m) => slug(m[1]!)))
}

describe('every link in a README lands', () => {
  it('names a file in this checkout, and a heading when it names an anchor', () => {
    const dead: string[] = []
    let checked = 0
    for (const rel of readmes()) {
      const file = path.join(ROOT, rel)
      const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '')
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const url = m[1]!
        const repo =
          /^https:\/\/github\.com\/vznjs\/vx\/(?:tree|blob)\/main\/([^?#]+)(?:#(.+))?$/.exec(url)
        let target: string
        let anchor: string | undefined
        if (repo !== null) {
          target = path.join(ROOT, repo[1]!)
          anchor = repo[2]
        } else if (/^[a-z]+:/i.test(url)) continue
        else {
          const [p, a] = url.split('#') as [string, string | undefined]
          target = p === '' ? file : path.resolve(path.dirname(file), p)
          anchor = a
        }
        checked += 1
        if (!existsSync(target)) {
          dead.push(`${rel}: ${url}`)
          continue
        }
        if (anchor !== undefined && statSync(target).isFile() && target.endsWith('.md'))
          if (!headings(target).has(anchor)) dead.push(`${rel}: ${url}`)
      }
    }
    expect(checked).toBeGreaterThanOrEqual(25)
    expect(dead).toEqual([])
  })
})
