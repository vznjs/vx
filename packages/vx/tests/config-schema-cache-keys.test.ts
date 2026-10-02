// wireit's `files` / `output` and include-style spellings in a cache block
// name vx's home (D-118).
import { expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

const hint = (cache: Record<string, unknown>): string | undefined => {
  try {
    validateProjectConfig(
      { tasks: { t: { exec: { command: 'x' }, cache } } } as never,
      'vx.config.ts',
    )
  } catch (err) {
    return (err as Error).message.split(' — ')[1] ?? (err as Error).message
  }
  return undefined
}
const ok = { inputs: { files: ['src/**'] }, outputs: { files: [] } }

it("names vx's home for a cache key another tool spells", () => {
  expect({
    files: hint({ ...ok, files: ['src/**'] }),
    output: hint({ ...ok, output: ['dist/**'] }),
    env: hint({ ...ok, env: ['CI'] }),
    dependencies: hint({ ...ok, dependencies: ['build'] }),
    enabled: hint({ ...ok, enabled: true }),
    inputGlobs: hint({ ...ok, inputs: { files: ['a'], globs: ['b'] } }),
    inputInclude: hint({ ...ok, inputs: { include: ['b'] } }),
    inputPatterns: hint({ ...ok, inputs: { files: ['a'], patterns: ['b'] } }),
    inputExclude: hint({ ...ok, inputs: { files: ['a'], exclude: ['b'] } }),
    inputIgnore: hint({ ...ok, inputs: { files: ['a'], ignore: ['b'] } }),
    outputGlobs: hint({ ...ok, outputs: { files: [], globs: ['b'] } }),
    outputInclude: hint({ ...ok, outputs: { include: ['b'] } }),
    outputExclude: hint({ ...ok, outputs: { files: ['d/**'], exclude: ['b'] } }),
    // CONTROL: a typo still gets the nearest spelling.
    typo: hint({ ...ok, inputz: {} }),
  }).toEqual({
    files: 'vx spells it `inputs.files`',
    output: 'vx spells it `outputs.files`',
    env: 'vx spells it `inputs.env`',
    dependencies: "vx spells it the task's `dependsOn` (an upstream's key folds into this one)",
    enabled:
      'vx spells it no field: a task with a `cache` block caches, one without runs every time',
    inputGlobs: 'vx spells it `files`',
    inputInclude: 'vx spells it `files`',
    inputPatterns: 'vx spells it `files`',
    inputExclude: "vx spells it `files` with a `!` entry (`'!**/*.test.ts'`)",
    inputIgnore: "vx spells it `files` with a `!` entry (`'!**/*.test.ts'`)",
    outputGlobs: 'vx spells it `files`',
    outputInclude: 'vx spells it `files`',
    outputExclude: "vx spells it `files` with a `!` entry (`'!dist/cache/**'`)",
    typo: 'did you mean inputs?',
  })
})
