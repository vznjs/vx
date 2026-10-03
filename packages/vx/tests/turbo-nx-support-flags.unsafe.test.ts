// docs/turbo-nx-support.md called `futureFlags.githubActionsRemoteBaseRefFallback`
// "not supported" while `turbo()` read it and followed it (J2-64). A flag row
// marked not supported is a claim the mapper's code never reads the flag.
// `.unsafe`: it reads @vzn/vx-migrate's source, outside core's directory.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const TURBO = path.resolve(import.meta.dir, '..', '..', 'vx-migrate', 'src', 'turbo')
const table = JSON.parse(
  readFileSync(path.join(import.meta.dir, 'contract', 'turbo-nx-support.json'), 'utf8'),
) as Array<{ key: string; status: string }>

/** turbo()'s code with comments dropped: a comment naming a flag reads nothing. */
function code(): string {
  return readdirSync(TURBO)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(path.join(TURBO, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('a futureFlags row marked not supported names a flag turbo() never reads', () => {
  it('holds for every such row', () => {
    const src = code()
    const flags = table.filter((r) => r.key.startsWith('turbo.json futureFlags.'))
    expect(flags.length).toBeGreaterThan(10)
    const read = flags
      .filter((r) => r.status === 'not-supported')
      .map((r) => r.key.slice('turbo.json futureFlags.'.length))
      .filter((f) => src.includes(f))
    expect(read).toEqual([])
  })

  it('the code scan sees a flag turbo() does read', () => {
    expect(code()).toContain('githubActionsRemoteBaseRefFallback')
  })
})
