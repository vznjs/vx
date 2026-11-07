// A module several configs import is evaluated once per process, so one
// config's change to it reached every config evaluated after it: b locked
// `echo a,b` beside a, and `echo b` alone or when a loaded later. A change
// to a shared module's exported values is refused, naming the module and
// the config that made it.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfigs } from '../src/workspace/project-loader.js'

async function load(shared: string, sources: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-modleak-'))
  try {
    await writeFile(path.join(dir, 's.mjs'), shared)
    const files = await Promise.all(
      sources.map(async (src, i) => {
        const file = path.join(dir, `p${i}`, 'vx.config.mjs')
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, src)
        return file
      }),
    )
    return await loadProjectConfigs(files).then(
      (configs) => `loaded ${configs.map((c) => c.tasks?.['t']?.exec?.command).join(' | ')}`,
      (err: Error) => err.message.replaceAll(dir, '<dir>'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const reg = 'export const reg = []\nexport const preset = { tasks: {} }\n'
const task = (command: string) =>
  `export default { tasks: { t: { exec: { command: ${command} } } } }\n`
const pushes = (p: string) =>
  `import { reg } from '../s.mjs'\nreg.push('${p}')\n${task("'echo ' + reg.join(',')")}`
const reads = `import { reg } from '../s.mjs'\n${task("'echo ' + reg.join(',')")}`
const refused = (n: number, exports: string) =>
  `<dir>/p${n}/vx.config.mjs changed ${exports} of <dir>/s.mjs while it was evaluated, and another project config imports that module: configs share one evaluation of it, so what they read from it depended on which loaded first; build a config's own value (\`[...list, x]\`, \`{ ...preset }\`) instead of changing a shared one`

it('two configs that change a shared module are refused, naming the first', async () => {
  expect(await load(reg, [pushes('a'), pushes('b')])).toBe(refused(0, 'export reg'))
})

it('one config that changes a shared module another only reads is refused, either order', async () => {
  expect(await load(reg, [pushes('a'), reads])).toBe(refused(0, 'export reg'))
  expect(await load(reg, [reads, pushes('b')])).toBe(refused(1, 'export reg'))
})

it('a change deep in a shared default or named object is refused', async () => {
  const edits = `import { preset } from '../s.mjs'\npreset.tasks.t = { exec: { command: 'echo edited' } }\nexport default preset\n`
  const copies = `import { preset } from '../s.mjs'\nexport default { ...preset }\n`
  expect(await load(reg, [copies, edits])).toBe(refused(1, 'export preset'))
})

it('configs that only read a shared module load as before', async () => {
  // CONTROL: copying is not changing, and a module one config imports alone is its own.
  const copiesA = `import { reg } from '../s.mjs'\n${task("'echo ' + [...reg, 'a'].join(',')")}`
  const copiesB = `import { reg } from '../s.mjs'\n${task("'echo ' + [...reg, 'b'].join(',')")}`
  expect(await load(reg, [copiesA, reads, copiesB])).toBe('loaded echo a | echo  | echo b')
  expect(await load(reg, [pushes('a')])).toBe('loaded echo a')
})
