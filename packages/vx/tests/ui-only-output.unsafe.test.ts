// The UI law: vx draws only with its ui components (src/ui). Nothing else
// in core or in a plugin that imports core writes to a stream, prints with
// `console`, names a colour, or emits a terminal escape: a verb or a
// plugin composes `ui.*` blocks and hands them to `ui.print`, says a line
// with `ui.say`, or writes bytes a program reads with `ui.data`.
// Design: docs/design/ui-2026-11.md.
//
// Out of scope: the servers (vx-cache-server, vx-history-server,
// vx-dte-server and vx-devtools, the code they share) never import core
// and log as servers; `.cjs` bridges a task runs (vx-migrate's nx-exec)
// write the task's own output.

import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const PACKAGES = path.join(import.meta.dir, '..', '..')
const ROOTS = [
  'vx/src',
  'vx-ci/src',
  'vx-dte/src',
  'vx-history/src',
  'vx-lockfile/src',
  'vx-migrate/src',
  'vx-otel/src',
  'vx-reapi/src',
  'vx-cache/src',
]

const RULES: readonly [what: string, re: RegExp][] = [
  ['a stream write', /\bprocess\.(?:stdout|stderr)\.write\b|\bBun\.(?:stdout|stderr)\b/],
  ['console output', /\bconsole\.(?:log|error|warn|info|debug|table|dir|trace)\b/],
  // In a string: a regex that reads a task's escapes draws nothing.
  ['a terminal escape', /(['"`])(?:(?!\1).)*\\(?:x1b|u001b|033)[[\]]/],
  ['a colour', /['"`]#[0-9a-fA-F]{6}['"`]/],
]

/**
 * Files that touch a stream and draw nothing of vx's own. Each says why.
 */
const GUARDS: Record<string, string> = {
  // While a config evaluates, its own prints go to stderr so stdout stays
  // vx's (a `--format json` reader's): it swaps the streams, it writes no line.
  'vx/src/workspace/project-loader.ts': "redirects a config's own prints to stderr",
}

async function sources(): Promise<string[]> {
  const out: string[] = []
  for (const root of ROOTS) {
    const dir = path.join(PACKAGES, root)
    for await (const rel of new Bun.Glob('**/*.ts').scan({ cwd: dir })) {
      if (root === 'vx/src' && rel.startsWith('ui/')) continue
      const file = path.join(root, rel)
      if (GUARDS[file] === undefined) out.push(file)
    }
  }
  return out.sort()
}

describe('ui is the only output', () => {
  it('nothing outside src/ui writes, prints, paints or escapes', async () => {
    const violations: string[] = []
    for (const file of await sources()) {
      const lines = (await Bun.file(path.join(PACKAGES, file)).text()).split('\n')
      lines.forEach((line, i) => {
        // A comment may name what it does not do.
        const code = line.replace(/^\s*(?:\/\/|\*|\/\*).*$/, '').replace(/\s\/\/ .*$/, '')
        for (const [what, re] of RULES)
          if (re.test(code)) violations.push(`${file}:${i + 1} ${what}`)
      })
    }
    expect(violations).toEqual([])
  })

  it('the scan reaches every root', async () => {
    const files = await sources()
    for (const root of ROOTS) expect(files.some((f) => f.startsWith(`${root}/`))).toBe(true)
  })
})
