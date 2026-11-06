// wireit's `files` / `output` / `dependencies` on a task, and include-style
// spellings in an inputs or outputs block, name vx's home (D-118).
import { expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

const hint = (task: Record<string, unknown>): string | undefined => {
  try {
    validateProjectConfig(
      { tasks: { t: { exec: { command: 'x' }, inputs: { files: ['src/**'] }, ...task } } } as never,
      'vx.config.ts',
    )
  } catch (err) {
    return (err as Error).message.split(' — ')[1] ?? (err as Error).message
  }
  return undefined
}
const ok = { outputs: { files: [] }, cache: true }

it("names vx's home for a task key another tool spells", () => {
  expect({
    files: hint({ ...ok, files: ['src/**'] }),
    output: hint({ ...ok, output: ['dist/**'] }),
    env: hint({ ...ok, env: ['CI'] }),
    dependencies: hint({ ...ok, dependencies: ['build'] }),
    inputGlobs: hint({ ...ok, inputs: { files: ['a'], globs: ['b'] } }),
    inputInclude: hint({ ...ok, inputs: { include: ['b'] } }),
    inputPatterns: hint({ ...ok, inputs: { files: ['a'], patterns: ['b'] } }),
    inputExclude: hint({ ...ok, inputs: { files: ['a'], exclude: ['b'] } }),
    inputIgnore: hint({ ...ok, inputs: { files: ['a'], ignore: ['b'] } }),
    outputGlobs: hint({ ...ok, outputs: { files: [], globs: ['b'] } }),
    outputInclude: hint({ ...ok, outputs: { include: ['b'] } }),
    outputExclude: hint({ ...ok, outputs: { files: ['d/**'], exclude: ['b'] } }),
    // CONTROL: a typo still gets the nearest spelling.
    typo: hint({ ...ok, outputz: {} }),
  }).toEqual({
    files: 'vx spells it `inputs.files`',
    output: 'vx spells it `outputs.files`',
    env: 'vx spells it `inputs.env` (to key the task on a variable) or `exec.env` (to pass one)',
    dependencies: "vx spells it `dependsOn` (an upstream's key goes into this one)",
    inputGlobs: 'vx spells it `files`',
    inputInclude: 'vx spells it `files`',
    inputPatterns: 'vx spells it `files`',
    inputExclude: "vx spells it `files` with a `!` entry (`'!**/*.test.ts'`)",
    inputIgnore: "vx spells it `files` with a `!` entry (`'!**/*.test.ts'`)",
    outputGlobs: 'vx spells it `files`',
    outputInclude: 'vx spells it `files`',
    outputExclude: "vx spells it `files` with a `!` entry (`'!dist/cache/**'`)",
    typo: 'did you mean outputs?',
  })
})
