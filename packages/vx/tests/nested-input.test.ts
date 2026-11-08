// A project's input glob whose fixed prefix lies inside a nested project
// keys nothing: the nested project's files are never another project's
// inputs. A `dist/**` input over a build output that holds its own project
// config was silently dropped from the key, and edits there hit. `vx lock`
// refuses it, naming the nested project and the workspaceFiles spelling.
// An output glob there saves nothing for the same reason: the run warned
// "outputs matched no files" over a file it had written, and the nested
// project's artifact could hold the outer task's bytes.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { lock } from './helpers/orchestrator.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function workspace(inputs: string[], outputs: string[] = []): Promise<string> {
  const root = await makeWorkspace({ prefix: 'vx-nested-input-', workspaceFile: false })
  roots.push(root)
  await addProject(root, 'a', {
    config: `export default { tasks: { build: {
  exec: { command: 'true' },
  inputs: { files: ${JSON.stringify(inputs)} },
  outputs: { files: ${JSON.stringify(outputs)} },
  cache: true,
} } }
`,
    files: { 'src/a.ts': 'a', 'dist/d.txt': 'd', 'distx/e.txt': 'e' },
  })
  await writeFile(
    path.join(root, 'packages/a/dist/vx.config.mjs'),
    "export default { tasks: { x: { exec: { command: 'true' } } } }\n",
  )
  return root
}

async function lockError(root: string): Promise<string | null> {
  try {
    await lock(root)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

describe('an input under a nested project', () => {
  it('is refused at lock, naming the project and the workspaceFiles glob', async () => {
    const msg = await lockError(await workspace(['src/**', 'dist/**']))
    expect(msg).toContain(
      'packages/a#build reads "dist/**" in inputs.files, which lies inside the project packages/a/dist',
    )
    expect(msg).toContain('inputs.workspaceFiles ("packages/a/dist/**")')
  })

  it('is refused as a literal file and as the directory itself', async () => {
    expect(await lockError(await workspace(['dist/d.txt']))).toContain(
      '"dist/d.txt" in inputs.files',
    )
    expect(await lockError(await workspace(['dist']))).toContain('"dist" in inputs.files')
  })

  it('is refused in one alternative of a brace', async () => {
    expect(await lockError(await workspace(['{src,dist}/**']))).toContain(
      '"{src,dist}/**" in inputs.files',
    )
  })

  it('is no refusal for a glob that only reaches past it, a sibling or a negation', async () => {
    expect(await lockError(await workspace(['**']))).toBeNull()
    expect(await lockError(await workspace(['distx/**', 'src/**']))).toBeNull()
    expect(await lockError(await workspace(['**', '!dist/**']))).toBeNull()
  })
})

describe('an output under a nested project', () => {
  it('is refused at lock, naming the project and the workspaceFiles glob', async () => {
    const msg = await lockError(await workspace(['src/**'], ['out/**', 'dist/o/**']))
    expect(msg).toContain(
      'packages/a#build writes "dist/o/**" in outputs.files, which lies inside the project packages/a/dist',
    )
    expect(msg).toContain('outputs.workspaceFiles ("packages/a/dist/o/**")')
  })

  it('is refused in one alternative of a brace', async () => {
    expect(await lockError(await workspace(['src/**'], ['{out,dist}/**']))).toContain(
      '"{out,dist}/**" in outputs.files',
    )
  })

  it('is no refusal for a sibling or a negation', async () => {
    expect(await lockError(await workspace(['src/**'], ['distx/**']))).toBeNull()
    expect(await lockError(await workspace(['src/**'], ['out/**', '!dist/**']))).toBeNull()
  })
})
