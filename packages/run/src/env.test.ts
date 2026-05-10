import { describe, expect, it } from 'vitest'
import { buildIsolatedEnv, explicitEnvForKey } from './env.js'

describe('buildIsolatedEnv', () => {
  it('passes essential allowlist values from source', () => {
    const env = buildIsolatedEnv({
      passThroughEnv: [],
      explicitEnv: {},
      source: { PATH: '/usr/bin', HOME: '/root', SECRET: 'leak' },
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/root')
    expect(env.SECRET).toBeUndefined()
  })

  it('omits essentials that are not set in source', () => {
    const env = buildIsolatedEnv({
      passThroughEnv: [],
      explicitEnv: {},
      source: {},
    })
    expect(env.PATH).toBeUndefined()
  })

  it('forwards passThroughEnv values from source', () => {
    const env = buildIsolatedEnv({
      passThroughEnv: ['AWS_REGION'],
      explicitEnv: {},
      source: { AWS_REGION: 'us-east-1', OTHER: 'leak' },
    })
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(env.OTHER).toBeUndefined()
  })

  it('does not include passThroughEnv vars that are unset in source', () => {
    const env = buildIsolatedEnv({
      passThroughEnv: ['MISSING'],
      explicitEnv: {},
      source: {},
    })
    expect('MISSING' in env).toBe(false)
  })

  it('applies explicit env values', () => {
    const env = buildIsolatedEnv({
      passThroughEnv: [],
      explicitEnv: { NODE_ENV: 'production' },
      source: {},
    })
    expect(env.NODE_ENV).toBe('production')
  })

  it('explicit env overrides passThroughEnv values', () => {
    const env = buildIsolatedEnv({
      passThroughEnv: ['NODE_ENV'],
      explicitEnv: { NODE_ENV: 'production' },
      source: { NODE_ENV: 'development' },
    })
    expect(env.NODE_ENV).toBe('production')
  })

  it('explicit env overrides essential allowlist values', () => {
    const env = buildIsolatedEnv({
      passThroughEnv: [],
      explicitEnv: { PATH: '/custom/bin' },
      source: { PATH: '/usr/bin' },
    })
    expect(env.PATH).toBe('/custom/bin')
  })
})

describe('explicitEnvForKey', () => {
  it('returns sorted [name, value] entries', () => {
    expect(explicitEnvForKey({ B: '2', A: '1' })).toEqual([
      ['A', '1'],
      ['B', '2'],
    ])
  })

  it('returns an empty array for an empty record', () => {
    expect(explicitEnvForKey({})).toEqual([])
  })
})
