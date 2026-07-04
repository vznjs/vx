import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ENVIRONMENTS_VERSION,
  activeEnvironment,
  environmentsPath,
  readEnvironmentsFile,
  writeEnvironmentsFile,
  type EnvironmentsFile,
} from '../src/environments.js'

// Every test pins VX_CLOUD_CONFIG at a fresh temp path so nothing ever touches
// a real ~/.config, and so the per-path read memo can't leak between tests.
const savedEnv = {
  VX_CLOUD_CONFIG: process.env['VX_CLOUD_CONFIG'],
  XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
  VX_CLOUD_ENV: process.env['VX_CLOUD_ENV'],
}

let dir: string
let cfgPath: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vx-environments-'))
  cfgPath = path.join(dir, 'environments.json')
  process.env['VX_CLOUD_CONFIG'] = cfgPath
  delete process.env['VX_CLOUD_ENV']
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = savedEnv.XDG_CONFIG_HOME
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function sampleFile(): EnvironmentsFile {
  return {
    version: ENVIRONMENTS_VERSION,
    active: 'team',
    environments: {
      team: { url: 'https://vx.example', token: 'tok-1' },
      staging: { url: 'https://stage.example', delegate: true },
    },
  }
}

describe('environmentsPath', () => {
  it('VX_CLOUD_CONFIG pins the exact path', () => {
    expect(environmentsPath()).toBe(cfgPath)
  })

  it('falls back to $XDG_CONFIG_HOME/vx-cloud/environments.json', () => {
    delete process.env['VX_CLOUD_CONFIG']
    process.env['XDG_CONFIG_HOME'] = '/xdg-config'
    expect(environmentsPath()).toBe('/xdg-config/vx-cloud/environments.json')
  })

  it('falls back to ~/.config/vx-cloud/environments.json', () => {
    delete process.env['VX_CLOUD_CONFIG']
    delete process.env['XDG_CONFIG_HOME']
    expect(environmentsPath()).toBe(
      path.join(os.homedir(), '.config', 'vx-cloud', 'environments.json'),
    )
  })
})

describe('write + read round-trip', () => {
  it('round-trips the versioned file and enforces mode 0600 / dir 0700', async () => {
    // A nested dir so writeEnvironmentsFile creates it (and its mode is ours).
    cfgPath = path.join(dir, 'nested', 'environments.json')
    process.env['VX_CLOUD_CONFIG'] = cfgPath

    const file = sampleFile()
    writeEnvironmentsFile(file)
    expect(readEnvironmentsFile()).toEqual(file)

    expect(((await stat(cfgPath)).mode & 0o777).toString(8)).toBe('600')
    expect(((await stat(path.dirname(cfgPath))).mode & 0o777).toString(8)).toBe('700')
  })

  it('returns undefined when the file is absent', () => {
    expect(readEnvironmentsFile()).toBeUndefined()
    expect(activeEnvironment()).toBeUndefined()
  })

  it('round-trips the ambient `distribute` policy (both true and a count)', () => {
    const file: EnvironmentsFile = {
      version: ENVIRONMENTS_VERSION,
      active: 'pool',
      environments: {
        pool: { url: 'https://vx.example', distribute: true },
        big: { url: 'https://big.example', distribute: 8 },
        plain: { url: 'https://plain.example' },
      },
    }
    writeEnvironmentsFile(file)
    const read = readEnvironmentsFile()
    expect(read).toEqual(file)
    // An entry without the field never gains it (additive-optional).
    expect(read!.environments['plain']).not.toHaveProperty('distribute')
  })

  it('rejects a non-boolean/number distribute', async () => {
    await writeFile(
      cfgPath,
      JSON.stringify({
        version: ENVIRONMENTS_VERSION,
        environments: { bad: { url: 'https://x', distribute: 'lots' } },
      }),
    )
    expect(() => readEnvironmentsFile()).toThrow(/distribute/)
  })
})

describe('malformed / unknown-version files', () => {
  it('malformed JSON: CLI path throws, plugin path declines', async () => {
    await writeFile(cfgPath, '{ not json')
    expect(() => readEnvironmentsFile()).toThrow(/malformed JSON/)
    expect(activeEnvironment()).toBeUndefined()
  })

  it('unknown version: CLI path throws, plugin path declines', async () => {
    await writeFile(cfgPath, JSON.stringify({ version: 99, environments: {} }))
    expect(() => readEnvironmentsFile()).toThrow(/version/)
    expect(activeEnvironment()).toBeUndefined()
  })

  it('an entry without a url: CLI path throws, plugin path declines', async () => {
    await writeFile(
      cfgPath,
      JSON.stringify({ version: 1, active: 'a', environments: { a: { token: 't' } } }),
    )
    expect(() => readEnvironmentsFile()).toThrow(/no url/)
    expect(activeEnvironment()).toBeUndefined()
  })
})

describe('activeEnvironment', () => {
  it('returns the file-active entry with its name', async () => {
    await writeFile(cfgPath, JSON.stringify(sampleFile()))
    expect(activeEnvironment()).toEqual({ name: 'team', url: 'https://vx.example', token: 'tok-1' })
  })

  it('VX_CLOUD_ENV overrides the file pointer; an unknown name declines', async () => {
    await writeFile(cfgPath, JSON.stringify(sampleFile()))
    process.env['VX_CLOUD_ENV'] = 'staging'
    expect(activeEnvironment()).toEqual({
      name: 'staging',
      url: 'https://stage.example',
      delegate: true,
    })
    process.env['VX_CLOUD_ENV'] = 'no-such-env'
    expect(activeEnvironment()).toBeUndefined()
  })

  it('declines when no active pointer and no override', async () => {
    await writeFile(
      cfgPath,
      JSON.stringify({ version: 1, environments: { a: { url: 'https://a.example' } } }),
    )
    expect(activeEnvironment()).toBeUndefined()
  })

  it('memoizes the read — one fs read shared across consults', async () => {
    await writeFile(cfgPath, JSON.stringify(sampleFile()))
    expect(activeEnvironment()!.name).toBe('team')

    // Overwrite the file BEHIND the memo: a second consult must not re-read
    // (this is the plugin's one-read-per-process laziness guarantee).
    const flipped = { ...sampleFile(), active: 'staging' }
    await writeFile(cfgPath, JSON.stringify(flipped))
    expect(activeEnvironment()!.name).toBe('team')

    // A CLI write refreshes the memo, so in-process verbs see their own write.
    writeEnvironmentsFile(flipped)
    expect(activeEnvironment()!.name).toBe('staging')
  })
})
