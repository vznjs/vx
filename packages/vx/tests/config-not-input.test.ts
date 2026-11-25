// vx's configs only generate the locks (M, 2026-11-25): a task reading
// `**` keys on its resolved config, never the config file's bytes, so a
// comment edit keeps its key and a definition change still moves it.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { lock } from './helpers/orchestrator.js'
import { dry } from './helpers/parity.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const made: string[] = []
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true })
})

const config = (command: string, note = '') => `${note}export default { tasks: { build: {
  exec: { command: '${command}' }, inputs: { files: ['**'] }, outputs: { files: [] }, cache: true,
} } }
`

async function key(root: string): Promise<string> {
  await lock(root)
  const [task] = await dry(root, ['build', '--all'])
  return task!.hash
}

it('a comment in vx.config keeps a ** task key; a definition change moves it', async () => {
  const root = await makeWorkspace({ prefix: 'vx-config-not-input-' })
  made.push(root)
  const dir = await addProject(root, 'app', {
    config: config('true'),
    files: { 'src/x': '1\n' },
  })
  const file = path.join(dir, 'vx.config.mjs')
  const before = await key(root)
  await writeFile(file, config('true', '// a note\n'))
  expect(await key(root)).toBe(before)
  await writeFile(file, config('echo built'))
  expect(await key(root)).not.toBe(before)
})
