// A config's process.chdir() moved the whole vx process, and every relative
// path resolved after it read from the config's choice (D-120). It is put
// back and refused, naming the config, alone or among others.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

async function refusal(sources: string[]): Promise<[string, string]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-chdir-'))
  const cwd = process.cwd()
  try {
    const files = await Promise.all(
      sources.map(async (src, i) => {
        const file = path.join(dir, `p${i}`, 'vx.config.mjs')
        await Bun.write(file, src)
        return file
      }),
    )
    const message = await loadProjectConfigs(files).then(
      () => 'loaded',
      (err: Error) => err.message.replaceAll(dir, '<dir>'),
    )
    return [message, process.cwd() === cwd ? 'cwd kept' : `cwd moved to ${process.cwd()}`]
  } finally {
    process.chdir(cwd)
    await rm(dir, { recursive: true, force: true })
  }
}

const moves = `process.chdir(${JSON.stringify(os.tmpdir())})\nexport default { tasks: {} }\n`
const innocent = 'export default { tasks: {} }\n'
const message = (n: number) =>
  `<dir>/p${n}/vx.config.mjs changed process.cwd (a chdir) while it was evaluated — a config must not change the built-ins vx runs on: other configs are read through them and cache keys are made with them; a task runs in its project directory, and \`cd <dir> && …\` in \`exec.command\` moves it`

it('puts back a config’s chdir and names the config', async () => {
  expect(await refusal([moves])).toEqual([message(0), 'cwd kept'])
  expect(await refusal([innocent, moves, innocent])).toEqual([message(1), 'cwd kept'])
  // CONTROL: configs that move nothing load.
  expect(await refusal([innocent, innocent])).toEqual(['loaded', 'cwd kept'])
})

it('rounds for two workspaces at once in one process both load', async () => {
  // Each round moves the cwd to its root; overlapping, the second moved the
  // first's mid-evaluation, and both were refused as a config's chdir.
  const cwd = process.cwd()
  const dirs = await Promise.all([0, 1].map(() => mkdtemp(path.join(os.tmpdir(), 'vx-chdir-'))))
  try {
    const slow = 'await new Promise((r) => setTimeout(r, 20))\nexport default { tasks: {} }\n'
    const rounds = await Promise.all(
      dirs.map(async (dir) => {
        const files = await Promise.all(
          [0, 1, 2].map(async (i) => {
            const file = path.join(dir, `p${i}`, 'vx.config.mjs')
            await Bun.write(file, slow)
            return file
          }),
        )
        return loadProjectConfigs(files, dir).then(
          () => 'loaded',
          (err: Error) => err.message,
        )
      }),
    )
    expect(rounds).toEqual(['loaded', 'loaded'])
    expect(process.cwd()).toBe(cwd)
  } finally {
    process.chdir(cwd)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  }
})
