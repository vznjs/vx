// Keys pasted into a project's vx.config from package.json, turbo.json and
// project.json, or a task's field one level too high, name vx's home (D-99).
import { expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/config-schema.js'

const where = (key: string): string | undefined => {
  try {
    validateProjectConfig({ [key]: {} } as never, 'vx.config.ts')
  } catch (err) {
    return (err as Error).message.split(' — ')[1]
  }
  return undefined
}

it("names vx's home for a project key another tool spells (D-99)", () => {
  expect(where('scripts')).toBe(
    "vx spells it `tasks` (a script is a task's `exec.command`; `vx init` writes them from package.json)",
  )
  expect(where('pipeline')).toBe(
    'vx spells it `tasks` (`bunx @vzn/vx-migrate` writes them from turbo.json)',
  )
  expect(where('namedInputs')).toBe(
    'vx spells it a module the vx.config imports, spread into `cache.inputs.files`',
  )
  expect(where('root')).toBe(
    "vx spells it no field: a project's directory is where its package.json sits",
  )
  expect(where('sourceRoot')).toBe("vx spells it a task's `cache.inputs.files`")
  expect(where('projectType')).toBe('vx spells it no field: vx runs every project alike')
  expect(where('dependsOn')).toBe(
    'vx spells it `tasks.<name>.dependsOn`: a project holds tasks, and each task its own `dependsOn`',
  )
  expect(where('cache')).toBe(
    'vx spells it `tasks.<name>.cache`: a project holds tasks, and each task its own `cache`',
  )
  expect(where('inputs')).toBe('vx spells it `tasks.<name>.cache.inputs.files`')
  expect(where('outputs')).toBe('vx spells it `tasks.<name>.cache.outputs.files`')
  expect(where('env')).toBe(
    'vx spells it `tasks.<name>.cache.inputs.env` (to key a task on it) or `tasks.<name>.exec.env`',
  )
  // CONTROL: a typo still gets the nearest spelling.
  expect(where('task')).toBe('did you mean tasks?')
})
