// A config's bare import under Yarn Plug'n'Play: the dependencies are
// installed, into a .pnp.cjs Bun does not read, and "install them first"
// sent the user to a `yarn install` that changed nothing.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

async function refusal(pnp: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-pnp-import-'))
  try {
    if (pnp) await writeFile(path.join(dir, '.pnp.cjs'), '')
    const file = path.join(dir, 'vx.config.ts')
    await writeFile(file, "import x from 'vx-no-such-pkg-d109'\nexport default { tasks: {} }\n")
    return await loadProjectConfig(file).then(
      () => 'loaded',
      (err: Error) => err.message.replace(file, '<config>'),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

it("names Plug'n'Play when a .pnp.cjs holds the install", async () => {
  expect(await refusal(true)).toBe(
    "Project config <config>: cannot find 'vx-no-such-pkg-d109' — Yarn Plug'n'Play installed the workspace's dependencies into .pnp.cjs, which Bun does not read; set `nodeLinker: node-modules` in .yarnrc.yml and run `yarn install`",
  )
  // CONTROL: no .pnp.cjs keeps the install remedy.
  expect(await refusal(false)).toBe(
    "Project config <config>: cannot find 'vx-no-such-pkg-d109' — no node_modules above the config provides it; install the workspace's dependencies first",
  )
})
