// A config's process.umask() set the mode of every file vx and its tasks
// wrote after it: a cache artifact and a task's outputs landed 000 (D-125).
// It is put back and refused, naming the config, alone or among others.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

async function refusal(sources: string[], times = 1): Promise<[string, string]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-umask-'))
  const mask = process.umask()
  try {
    const files = await Promise.all(
      sources.map(async (src, i) => {
        const file = path.join(dir, `p${i}`, 'vx.config.mjs')
        await Bun.write(file, src)
        return file
      }),
    )
    let message = ''
    // A second load of a file evaluates it in the worker, whose umask is
    // the process's too.
    for (let i = 0; i < times; i++) {
      message = await loadProjectConfigs(files).then(
        () => 'loaded',
        (err: Error) => err.message.replaceAll(dir, '<dir>'),
      )
    }
    return [message, process.umask() === mask ? 'umask kept' : `umask moved to ${process.umask()}`]
  } finally {
    process.umask(mask)
    await rm(dir, { recursive: true, force: true })
  }
}

const changes = 'process.umask(0o777)\nexport default { tasks: {} }\n'
const innocent = 'export default { tasks: {} }\n'
const message = (n: number) =>
  `<dir>/p${n}/vx.config.mjs changed process.umask while it was evaluated — a config must not change the built-ins vx runs on: other configs are read through them and cache keys are made with them; a task sets its own with \`umask <mode> && …\` in \`exec.command\``

it('puts back a config’s umask and names the config', async () => {
  expect(await refusal([changes])).toEqual([message(0), 'umask kept'])
  expect(await refusal([innocent, changes, innocent])).toEqual([message(1), 'umask kept'])
  expect(await refusal([changes], 2)).toEqual([message(0), 'umask kept'])
  // CONTROLS: a config that sets the umask it found, and configs that touch nothing.
  const same = `process.umask(${process.umask()})\nexport default { tasks: {} }\n`
  expect(await refusal([same, innocent])).toEqual(['loaded', 'umask kept'])
  expect(await refusal([innocent, innocent])).toEqual(['loaded', 'umask kept'])
})
