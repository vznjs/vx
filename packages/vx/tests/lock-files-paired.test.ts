// `vx lock` renames projects.lock and dependencies.lock one after the other.
// A run reading between the two renames paired the new projects with the old
// edges. Both renames happen under an exclusive hold and a run reads both
// files under a shared one, so a run started in the gap waits for the pair.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { runLockPath } from '../src/orchestrator/run-lock.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

const config = (word: string) => `
  export default { tasks: { say: { exec: { command: 'echo ${word}' } } } }
`

function vx(cwd: string, args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    VX_LOCK_REVIEW_FILES: 'false',
  }
  delete env['CI']
  delete env['GITHUB_ACTIONS']
  return Bun.spawn([process.execPath, BIN, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
}

async function done(proc: ReturnType<typeof vx>): Promise<{ code: number; out: string }> {
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: out + err }
}

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-lock-paired-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a run started between the two renames of `vx lock` reads both new files', async () => {
  const projects = path.join(root, '.vx', 'projects.lock')
  const dependencies = path.join(root, '.vx', 'dependencies.lock')
  await addProject(root, 'core', config('core-said'))
  expect((await done(vx(root, ['lock']))).code).toBe(0)
  const old = [await readFile(projects), await readFile(dependencies)] as const
  await addProject(root, 'extra', config('extra-said'))
  expect((await done(vx(root, ['lock']))).code).toBe(0)
  const fresh = [await readFile(projects), await readFile(dependencies)] as const
  await writeFile(projects, old[0])
  await writeFile(dependencies, old[1])

  // `vx lock`'s write, held open after its first rename.
  const file = `${runLockPath(root)}-files`
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file)
  db.exec('BEGIN EXCLUSIVE')
  await writeFile(`${projects}.tmp-t`, fresh[0])
  await rename(`${projects}.tmp-t`, projects)
  const run = vx(root, ['run', 'say', '--all'])
  // A run that does not wait ends on its own before this: the mix it read.
  await Promise.race([run.exited, Bun.sleep(2_000)])
  await writeFile(`${dependencies}.tmp-t`, fresh[1])
  await rename(`${dependencies}.tmp-t`, dependencies)
  db.close()

  const { code, out } = await done(run)
  expect(out).not.toContain('holds other projects')
  expect(code).toBe(0)
  expect(out).toMatch(/success .* extra#say/)
}, 30_000)
