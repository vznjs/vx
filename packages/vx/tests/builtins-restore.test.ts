import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

// The built-ins check reads by position first: the same keys in the same
// order with the same descriptors is "unchanged". These rows hold what that
// fast path must hand to the full check: a key gone, and a key gone with
// another added in its place, which keeps the count.
describe('a config that deletes a built-in (D-74)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vx-d74d-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const REFUSAL = (who: string, props: string) =>
    `${who} changed ${props} while it was evaluated — a config must not change the built-ins vx runs on: other configs are read through them and cache keys are made with them`
  const task = "export default { tasks: { t: { exec: { command: 'true' } } } }\n"
  // A child each: without the check the change outlives the load.
  const drive = async (body: string, after: string): Promise<unknown> => {
    const file = path.join(dir, 'p', 'vx.config.mjs')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body + task)
    const driver = path.join(dir, 'drive.ts')
    await writeFile(
      driver,
      `import { loadProjectConfigs } from ${JSON.stringify(path.resolve(import.meta.dir, '../src/workspace/project-loader.ts'))}\n` +
        `const max = Math.max\n` +
        `const got = await loadProjectConfigs([${JSON.stringify(file)}]).then(() => 'loaded', (e) => e.message)\n` +
        `console.error(JSON.stringify({ got, after: ${after} }))\n`,
    )
    const p = Bun.spawn({ cmd: [process.execPath, driver], stdout: 'pipe', stderr: 'pipe' })
    const [, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
    return { ...(JSON.parse(err) as object), file }
  }

  it('refuses a deleted property, names it, and puts it back', async () => {
    const got = await drive('delete Math.max\n', 'Math.max === max')
    const file = path.join(dir, 'p', 'vx.config.mjs')
    expect(got).toEqual({ got: REFUSAL(file, 'Math.max'), after: true, file })
  })

  it('refuses a deleted LAST property: the keys left are a prefix of the ones before', async () => {
    const got = await drive(
      'delete Math[Symbol.toStringTag]\n',
      "Math[Symbol.toStringTag] === 'Math'",
    )
    const file = path.join(dir, 'p', 'vx.config.mjs')
    expect(got).toEqual({
      got: REFUSAL(file, 'Math.Symbol(Symbol.toStringTag)'),
      after: true,
      file,
    })
  })

  it('refuses a delete and an add that keep the count, and undoes both', async () => {
    const got = await drive('delete Math.max\nMath.mx = 1\n', "Math.max === max && !('mx' in Math)")
    const file = path.join(dir, 'p', 'vx.config.mjs')
    expect(got).toEqual({ got: REFUSAL(file, 'Math.mx, Math.max'), after: true, file })
  })

  it('CONTROL: a config that leaves them alone loads', async () => {
    const got = await drive('', 'Math.max === max')
    const file = path.join(dir, 'p', 'vx.config.mjs')
    expect(got).toEqual({ got: 'loaded', after: true, file })
  })
})
