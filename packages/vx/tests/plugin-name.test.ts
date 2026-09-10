// A plugin's name is its package name and nothing else. `definePlugin`
// reads the nearest package.json above the module that calls it and stamps
// the name where the workspace loader checks; a plain object, a plugin
// that names itself, or one whose name was overwritten after the stamp is
// refused at the one boundary every plugin crosses. The refusals are the
// claim; the accepted forms are the controls.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { definePlugin } from '../src/index.js'
import { loadWorkspaceConfig } from '../src/workspace/index.js'
import { PLUGIN_IMPORT, pluginOrigin, pluginSource, testPlugin } from './helpers/plugin.js'

describe('definePlugin — the name is the package name', () => {
  it('reads the nearest package.json above the module', () => {
    const p = testPlugin('@acme/vx-thing', { teardown() {} })
    expect(p.name).toBe('@acme/vx-thing')
    expect(typeof p.teardown).toBe('function')
  })

  it('walks up from a nested module directory, and accepts import.meta.url', () => {
    const { dir } = pluginOrigin('@acme/nested')
    const deep = path.join(dir, 'src', 'lib')
    mkdirSync(deep, { recursive: true })
    expect(definePlugin({ dir: deep }, {}).name).toBe('@acme/nested')
    expect(definePlugin({ url: pathToFileURL(path.join(deep, 'index.ts')).href }, {}).name).toBe(
      '@acme/nested',
    )
  })

  it('refuses a name field: there is nothing to override', () => {
    expect(() => definePlugin(pluginOrigin('@acme/named'), { name: 'other' } as never)).toThrow(
      /name is its package name/,
    )
  })

  it('refuses a module with no package above it, and a package with no name', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'vx-no-pkg-'))
    // The temp root's parents carry no package.json either, or the walk
    // would find one; assert the message names the walk's start.
    expect(() => definePlugin({ dir: bare }, {})).toThrow(/no package.json above/)
    const unnamed = mkdtempSync(path.join(tmpdir(), 'vx-unnamed-pkg-'))
    writeFileSync(path.join(unnamed, 'package.json'), JSON.stringify({ private: true }))
    expect(() => definePlugin({ dir: unnamed }, {})).toThrow(/has no name/)
  })

  it('refuses an origin that is not import.meta', () => {
    expect(() => definePlugin({}, {})).toThrow(/must be the plugin module's import.meta/)
  })
})

describe('the workspace boundary accepts only definePlugin output', () => {
  async function load(pluginsSource: string): Promise<unknown> {
    const dir = mkdtempSync(path.join(tmpdir(), 'vx-plugin-boundary-'))
    writeFileSync(
      path.join(dir, 'vx.workspace.mjs'),
      `${PLUGIN_IMPORT}export default { plugins: [${pluginsSource}] }\n`,
    )
    return loadWorkspaceConfig(dir)
  }

  it('CONTROL: a defined plugin loads under its package name', async () => {
    const cfg = (await load(pluginSource('@acme/ok', `{ teardown() {} }`))) as {
      plugins: Array<{ name: string }>
    }
    expect(cfg.plugins.map((p) => p.name)).toEqual(['@acme/ok'])
  })

  it('refuses a plain object, even one with a name', async () => {
    await expect(load(`{ name: 'org/plain', teardown() {} }`)).rejects.toThrow(
      /plugins\[0\]` must come from definePlugin\(import.meta/,
    )
  })

  it('refuses a name overwritten after the stamp', async () => {
    await expect(
      load(`{ ...${pluginSource('@acme/stamped', `{ teardown() {} }`)}, name: 'org/other' }`),
    ).rejects.toThrow(/overrides the package name \('org\/other' over '@acme\/stamped'\)/)
  })
})
