// An `outputs.workspaceFiles` glob may name any path under the root, so
// `packages/b/**` covered another project's config: vx cleans a task's
// outputs before it runs, and the run deleted b's untracked files. `vx lock`
// refuses a root-anchored output that covers any project's `vx.config.*`,
// as `outputs.files` refuses one covering its own.

import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'bun:test'
import { lock } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function lockError(outputs: string[]): Promise<string | null> {
  const root = await makeWorkspace({ prefix: 'vx-ws-output-config-', workspaceFile: false })
  roots.push(root)
  await addProject(root, 'a', {
    config: `export default { tasks: { gen: {
  exec: { command: 'true' },
  inputs: { files: ['src/**'] },
  outputs: { files: [], workspaceFiles: ${JSON.stringify(outputs)} },
  cache: true,
} } }
`,
    files: { 'src/a.ts': 'a' },
  })
  await addProject(root, 'b', "export default { tasks: { x: { exec: { command: 'true' } } } }\n")
  try {
    await lock(root)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** The refusal as `vx lock` prints it. */
const said = (glob: string, config: string, project: string) =>
  '✗ vx lock  lock not written\n\n' +
  `  packages/a#gen: outputs.workspaceFiles "${glob}" covers ${config}, the config of the ` +
  `project ${project} — vx deletes a task's outputs before it runs and restores them on a hit, ` +
  `so the project would lose its config\n` +
  `  Name the directory the task writes, or take the file back with "!${config}"`

describe('an outputs.workspaceFiles glob over a project config', () => {
  it("is refused at lock for another project's config and the task's own", async () => {
    expect(await lockError(['packages/b/**'])).toBe(
      said('packages/b/**', 'packages/b/vx.config.mjs', 'packages/b'),
    )
    expect(await lockError(['packages/a/*.mjs'])).toBe(
      said('packages/a/*.mjs', 'packages/a/vx.config.mjs', 'packages/a'),
    )
    expect(await lockError(['packages/b/vx.config.mjs'])).toBe(
      said('packages/b/vx.config.mjs', 'packages/b/vx.config.mjs', 'packages/b'),
    )
  })

  it('CONTROL: a directory beside the config, or the config taken back, passes', async () => {
    expect(await lockError(['packages/b/dist/**'])).toBeNull()
    expect(await lockError(['packages/b/**', '!packages/b/vx.config.mjs'])).toBeNull()
  })
})
