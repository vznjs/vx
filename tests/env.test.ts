import { describe, expect, it } from 'bun:test'
import { buildIsolatedEnv } from '../src/exec/env.js'

describe('buildIsolatedEnv', () => {
  it('passes essential allowlist values from source', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: { PATH: '/usr/bin', HOME: '/root', SECRET: 'leak' },
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/root')
    expect(env.SECRET).toBeUndefined()
  })

  it('omits essentials that are not set in source', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: {},
      source: {},
    })
    expect(env.PATH).toBeUndefined()
  })

  it('forwards passThrough values from source', () => {
    const env = buildIsolatedEnv({
      passThrough: ['AWS_REGION'],
      define: {},
      source: { AWS_REGION: 'us-east-1', OTHER: 'leak' },
    })
    expect(env.AWS_REGION).toBe('us-east-1')
    expect(env.OTHER).toBeUndefined()
  })

  it('does not include passThrough vars that are unset in source', () => {
    const env = buildIsolatedEnv({
      passThrough: ['MISSING'],
      define: {},
      source: {},
    })
    expect('MISSING' in env).toBe(false)
  })

  it('applies define values', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: { NODE_ENV: 'production' },
      source: {},
    })
    expect(env.NODE_ENV).toBe('production')
  })

  it('define overrides passThrough values', () => {
    const env = buildIsolatedEnv({
      passThrough: ['NODE_ENV'],
      define: { NODE_ENV: 'production' },
      source: { NODE_ENV: 'development' },
    })
    expect(env.NODE_ENV).toBe('production')
  })

  it('define overrides essential allowlist values', () => {
    const env = buildIsolatedEnv({
      passThrough: [],
      define: { PATH: '/custom/bin' },
      source: { PATH: '/usr/bin' },
    })
    expect(env.PATH).toBe('/custom/bin')
  })
})
