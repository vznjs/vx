// The registry vx init / vx upgrade read releases from: the user's own
// package-manager config, npmjs.org only when nothing names one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { resolveRegistry } from '../src/cli/registry.js'

const root = mkdtempSync(path.join(os.tmpdir(), 'vx-registry-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let n = 0
/** A fresh home and a project under it, with `files` written relative to the home. */
function world(files: Record<string, string>): { home: string; cwd: string } {
  const home = path.join(root, `w${n++}`)
  const cwd = path.join(home, 'work', 'app')
  mkdirSync(cwd, { recursive: true })
  for (const [rel, text] of Object.entries(files)) writeFileSync(path.join(home, rel), text)
  return { home, cwd }
}

const resolve = (w: { home: string; cwd: string }, env: Record<string, string> = {}) =>
  resolveRegistry('@vzn', w.cwd, env, w.home)

describe('resolveRegistry', () => {
  it('names npmjs.org, with no credentials, when nothing is configured', () => {
    const r = resolve(world({}))
    expect(r.url).toBe('https://registry.npmjs.org/')
    expect(r.auth('https://registry.npmjs.org/@vzn/vx/latest')).toBeUndefined()
  })

  it('reads the project .npmrc, and sends its token under that registry only', () => {
    const r = resolve(
      world({
        'work/.npmrc':
          '; corp mirror\nregistry = "https://npm.corp.example/api/npm"\n//npm.corp.example/api/npm/:_authToken=${TOKEN}\n',
      }),
      { TOKEN: 't0k' },
    )
    expect(r.url).toBe('https://npm.corp.example/api/npm/')
    expect(r.auth('https://npm.corp.example/api/npm/@vzn/vx/latest')).toBe('Bearer t0k')
    expect(r.auth('https://npm.corp.example/other/@vzn/vx/latest')).toBeUndefined()
    expect(r.auth('https://registry.npmjs.org/@vzn/vx/latest')).toBeUndefined()
  })

  it('a scoped registry beats the environment, which beats the .npmrc files', () => {
    const scoped = world({
      '.npmrc': '@vzn:registry=https://vzn.example/\nregistry=https://user.example/\n',
    })
    expect(resolve(scoped, { npm_config_registry: 'https://env.example' }).url).toBe(
      'https://vzn.example/',
    )
    const plain = world({ '.npmrc': 'registry=https://user.example/\n' })
    expect(resolve(plain, { NPM_CONFIG_REGISTRY: 'https://env.example' }).url).toBe(
      'https://env.example/',
    )
    expect(resolve(plain).url).toBe('https://user.example/')
  })

  it('a nearer .npmrc beats the user one, and npm_config_userconfig moves the user one', () => {
    const w = world({
      '.npmrc': 'registry=https://user.example/\n',
      'work/.npmrc': 'registry=https://project.example/\n',
      'ci.npmrc': '//user.example/:_auth=dTpw\n',
    })
    expect(resolve(w).url).toBe('https://project.example/')
    const ci = world({
      'ci.npmrc': 'registry=https://ci.example/\n//ci.example/:_auth=dTpw\n',
    })
    const r = resolve(ci, { npm_config_userconfig: path.join(ci.home, 'ci.npmrc') })
    expect(r.url).toBe('https://ci.example/')
    expect(r.auth('https://ci.example/@vzn/vx/-/vx-1.0.0.tgz')).toBe('Basic dTpw')
  })

  it('bunfig answers when no .npmrc names a registry: the scope first, then install.registry', () => {
    const scoped = world({
      'work/bunfig.toml':
        '[install]\nregistry = "https://bun.example/"\n[install.scopes]\nvzn = { url = "https://vzn.bun.example", token = "$BUN_TOKEN" }\n',
    })
    const r = resolve(scoped, { BUN_TOKEN: 'b' })
    expect(r.url).toBe('https://vzn.bun.example/')
    expect(r.auth('https://vzn.bun.example/@vzn/vx/latest')).toBe('Bearer b')
    expect(r.auth('https://bun.example/@vzn/vx/latest')).toBeUndefined()

    const global = world({
      '.bunfig.toml': '[install]\nregistry = "https://u:p%40ss@bun.example/npm"\n',
    })
    const g = resolve(global)
    expect(g.url).toBe('https://bun.example/npm/')
    expect(g.auth('https://bun.example/npm/@vzn/vx/latest')).toBe(
      `Basic ${Buffer.from('u:p@ss').toString('base64')}`,
    )

    const both = world({
      '.npmrc': 'registry=https://npm.example/\n',
      '.bunfig.toml': '[install]\nregistry = "https://bun.example/"\n',
    })
    expect(resolve(both).url).toBe('https://npm.example/')
  })

  it('a bunfig that is not TOML is one refusal naming the file', () => {
    const w = world({ 'work/bunfig.toml': '[install\n' })
    expect(() => resolve(w)).toThrow(`${path.join(w.home, 'work', 'bunfig.toml')}: not valid TOML`)
  })
  it('a registry that is no http(s) URL is one refusal naming where it was set', () => {
    // `registry=npm.corp.example` crashed `vx upgrade` with a TypeError stack.
    const w = world({ 'work/.npmrc': 'registry=npm.corp.example\n' })
    expect(() => resolve(w)).toThrow(
      `registry "npm.corp.example" in ${path.join(w.home, 'work', '.npmrc')} is not an http(s) URL`,
    )
    expect(() => resolve(world({}), { npm_config_registry: 'ftp://x' })).toThrow(
      'registry "ftp://x" in npm_config_registry is not an http(s) URL',
    )
    const b = world({ '.bunfig.toml': '[install]\nregistry = "bun.example"\n' })
    expect(() => resolve(b)).toThrow(
      `registry "bun.example" in ${path.join(b.home, '.bunfig.toml')} is not an http(s) URL`,
    )
  })
})
