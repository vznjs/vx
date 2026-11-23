// A piped run is what an agent reads (its shell is a pipe), so it must say
// what a terminal user sees without asking: what each row's columns mean,
// and where a failed command ran. A task prints paths relative to its own
// project; read from the workspace root or another project, `src/index.js`
// named the wrong file.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

const CONFIG = `
  export default {
    tasks: {
      ok: { exec: { command: 'echo fine' } },
      boom: { exec: { command: "echo \\"cp: cannot stat 'src/index.js'\\" && exit 1" } },
    },
  }
`

async function vx(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1' }
  delete env['CI']
  delete env['GITHUB_ACTIONS']
  delete env['FORCE_COLOR']
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, out }
}

describe('a piped run reads without a terminal', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-piped-reader-' })
    await addProject(root, 'core', CONFIG)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names the columns once over the task rows', async () => {
    const { code, out } = await vx(root, ['run', 'ok', 'boom', '--all'])
    expect(code).toBe(1)
    const lines = out.split('\n')
    const head = lines.findIndex((l) =>
      /^  Tasks\s+status\s+cache\s+±usual\s+time\b.*\btask$/.test(l),
    )
    const firstRow = lines.findIndex((l) => /core#(ok|boom)$/.test(l))
    expect(head).toBeGreaterThanOrEqual(0)
    expect(head).toBeLessThan(firstRow)
    expect(lines.filter((l) => /\bstatus\s+cache\s+±usual/.test(l))).toHaveLength(1)
  })

  it("a failed frame's command line names the directory it ran in", async () => {
    const { out } = await vx(root, ['run', 'boom', '--all'])
    expect(out).toContain(`packages/core $ echo "cp: cannot stat 'src/index.js'" && exit 1`)
  })

  it("vx last --format json gives a failed row its project's directory", async () => {
    await vx(root, ['run', 'boom', '--all'])
    const { out } = await vx(root, ['last', '--format', 'json'])
    const row = (JSON.parse(out) as { tasks: { task: string; dir?: string }[] }).tasks.find(
      (t) => t.task === 'boom',
    )
    expect(row?.dir).toBe('packages/core')
  })
})
