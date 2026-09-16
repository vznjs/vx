// A red run's footer said "1 skipped" and nothing about which task or by
// what (item 266): the broad flow prints no row for a skipped task. The
// Skipped section names each under the failure that blocked it; under
// --continue=always nothing is skipped and the section is absent.
import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import path from 'node:path'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function vx(cwd: string, args: string[]): { code: number; text: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', CI: '' },
  })
  return {
    code: p.exitCode ?? 1,
    text: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  }
}

describe('the Skipped section', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-skipped-' })
    await addProject(root, 'lib', {
      config: `export default { tasks: { build: { exec: { command: 'exit 3' } } } }\n`,
      files: {},
    })
    await addProject(root, 'app', {
      config: `export default { tasks: { build: { dependsOn: ['^build'], exec: { command: 'echo built' } } } }\n`,
      files: {},
      deps: { lib: '*' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names the skipped task under the failure that blocked it', () => {
    const r = vx(root, ['run', 'build', '--all'])
    expect(r.code).toBe(1)
    expect(r.text).toContain('1 failed · 1 skipped · 2 total')
    expect(r.text).toContain(
      '  Skipped:  1 task never started — blocked upstream\n    ⊘ after lib#build failed: app#build\n',
    )
  })

  it('the summarize row names the blocker; a failed row carries none', async () => {
    const out = path.join(root, 's.json')
    vx(root, ['run', 'build', '--all', `--summarize=${out}`])
    const rows = (JSON.parse(await Bun.file(out).text()) as { tasks: Record<string, unknown>[] })
      .tasks
    const byId = new Map(rows.map((r) => [r['id'], r]))
    expect(byId.get('app#build')?.['blockedBy']).toBe('lib#build')
    expect(byId.get('lib#build')?.['blockedBy']).toBeUndefined()
  })

  // CONTROL: nothing skipped, no section.
  it('prints no section when the run skipped nothing', () => {
    const r = vx(root, ['run', 'build', '--all', '--continue=always'])
    expect(r.code).toBe(1)
    expect(r.text).not.toContain('Skipped:')
  })
})
