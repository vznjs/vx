// turboCache() and nxCache() refuse a timeout they cannot wait on. A
// negative or non-number one made AbortSignal.timeout throw on every
// request (turbo), and a zero one aborted each as it started (nx; Turbo
// reads 0 as no deadline, so turboCache takes it) (stream F). Each
// refusal names the factory, as every plugin's does, and a NaN reads NaN
// (JSON.stringify printed it as null).
import { expect, it } from 'bun:test'
import { resolveNxCacheConfig } from '../src/nx-cache/index.js'
import { resolveTurboCacheConfig } from '../src/turbo-cache/index.js'

const said = (make: () => { timeoutMs: number } | undefined): string => {
  try {
    return `timeout ${make()?.timeoutMs}`
  } catch (err) {
    return (err as Error).message
  }
}
const turbo = (o: Record<string, unknown>) => () =>
  resolveTurboCacheConfig({ apiUrl: 'https://cache.example.com', token: 't', ...o } as never, {})
const nx = (o: Record<string, unknown>) => () =>
  resolveNxCacheConfig({ server: 'https://cache.example.com', ...o } as never, {})

it('turboCache refuses a negative or non-number timeout, and takes 0', () => {
  expect(said(turbo({ timeoutMs: -1 }))).toBe(
    'turboCache(): timeoutMs must be ms ≥ 0 (0: none), got -1',
  )
  expect(said(turbo({ uploadTimeoutMs: '60' }))).toBe(
    'turboCache(): uploadTimeoutMs must be ms ≥ 0 (0: none), got "60"',
  )
  expect(said(turbo({ timeoutMs: Number.NaN }))).toBe(
    'turboCache(): timeoutMs must be ms ≥ 0 (0: none), got NaN',
  )
  expect(said(turbo({ timeoutMs: 0 }))).toBe('timeout 0')
  expect(said(turbo({ timeoutMs: 5000 }))).toBe('timeout 5000')
})

it('nxCache refuses a timeout that is not a positive number', () => {
  expect(said(nx({ timeoutMs: 0 }))).toBe(
    'nxCache(): timeoutMs must be a positive number of ms, got 0',
  )
  expect(said(nx({ timeoutMs: Number.NaN }))).toBe(
    'nxCache(): timeoutMs must be a positive number of ms, got NaN',
  )
  expect(said(nx({ timeoutMs: 5000 }))).toBe('timeout 5000')
})
