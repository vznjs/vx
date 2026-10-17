// `vx docs` without the network: the pages its tag holds are this tree's
// docs, and the command runs in process with them.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spyOn } from 'bun:test'
import { docsCmd } from '../../src/cli/docs.js'

const DOCS = path.resolve(import.meta.dir, '..', '..', 'docs')

/** The pages as the tag holds them: this tree's docs/*.md, STATUS.md aside. */
export const diskPages = async (): Promise<Record<string, string>> =>
  Object.fromEntries(
    readdirSync(DOCS)
      .filter((f) => f.endsWith('.md') && f !== 'STATUS.md')
      .map((f) => [f.slice(0, -3), readFileSync(path.join(DOCS, f), 'utf8')]),
  )

/** Run `vx docs` in process over `load`'s pages; its exit and what it printed. */
export async function docsIn(
  args: string[],
  load: (ref: string) => Promise<Record<string, string>> = diskPages,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const o = spyOn(process.stdout, 'write').mockImplementation((c) => (out.push(String(c)), true))
  const e = spyOn(process.stderr, 'write').mockImplementation((c) => (err.push(String(c)), true))
  try {
    const code = await docsCmd(args, load)
    return { code, out: out.join(''), err: err.join('') }
  } finally {
    o.mockRestore()
    e.mockRestore()
  }
}
