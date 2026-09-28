// `vx init --plugin <seam>` writes the runnable example plugin and its test
// from packages/vx-plugin-examples/plugins, where the gate runs them. Core
// cannot import a sibling package (and a compiled binary carries no other
// package's files), so src/cli/plugin-templates.ts holds a copy, generated
// from those files. This law holds the copy to them, seam for seam and byte
// for byte:
//   VX_UPDATE_CONTRACT=1 bun test tests/plugin-templates.unsafe.test.ts
//
// `.unsafe`: it reads another package's files (the cross-project law).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { PLUGIN_TEMPLATES } from '../src/cli/plugin-templates.js'

const EXAMPLES = path.resolve(import.meta.dir, '..', '..', 'vx-plugin-examples', 'plugins')
const OUT = path.resolve(import.meta.dir, '..', 'src', 'cli', 'plugin-templates.ts')

function fromExamples(): Record<string, { plugin: string; test: string }> {
  const seams = readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => f.slice(0, -'.test.ts'.length))
    .sort()
  return Object.fromEntries(
    seams.map((s) => [
      s,
      {
        plugin: readFileSync(path.join(EXAMPLES, `${s}.ts`), 'utf8'),
        test: readFileSync(path.join(EXAMPLES, `${s}.test.ts`), 'utf8'),
      },
    ]),
  )
}

it("core's plugin templates are the examples' files, every seam", () => {
  const want = fromExamples()
  if (process.env['VX_UPDATE_CONTRACT'] === '1') {
    writeFileSync(
      OUT,
      [
        '// Generated from packages/vx-plugin-examples/plugins by',
        '// tests/plugin-templates.unsafe.test.ts; edit the examples, then',
        '// VX_UPDATE_CONTRACT=1 that test. `vx init --plugin <seam>` writes these.',
        '',
        `export const PLUGIN_TEMPLATES: Readonly<Record<string, { plugin: string; test: string }>> = ${JSON.stringify(want, null, 2)}`,
        '',
      ].join('\n'),
    )
  }
  expect(Object.keys(want)).toHaveLength(9)
  expect(PLUGIN_TEMPLATES).toEqual(want)
})
