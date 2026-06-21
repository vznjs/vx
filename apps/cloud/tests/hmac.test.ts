// HMAC compute/verify against the Turbo-compatible scheme
// (hash || teamId || body). Pure Web Crypto — runs in Bun too.

import { describe, expect, it } from 'bun:test'
import { computeArtifactTag, verifyArtifactTag } from '../src/hmac.js'

const KEY = 'super-secret-test-key'
const HASH = 'deadbeefdeadbeef'
const TEAM = 'acme'

describe('HMAC artifact tag (Turbo wire compatible)', () => {
  it('compute → verify round-trips on the same inputs', async () => {
    const body = new TextEncoder().encode('hello world').buffer as ArrayBuffer
    const tag = await computeArtifactTag(KEY, HASH, TEAM, body)
    expect(typeof tag).toBe('string')
    expect(tag.length).toBeGreaterThan(0)
    const ok = await verifyArtifactTag(KEY, HASH, TEAM, body, tag)
    expect(ok).toBe(true)
  })

  it('verify rejects a tampered body', async () => {
    const body = new TextEncoder().encode('original').buffer as ArrayBuffer
    const tampered = new TextEncoder().encode('tampered').buffer as ArrayBuffer
    const tag = await computeArtifactTag(KEY, HASH, TEAM, body)
    const ok = await verifyArtifactTag(KEY, HASH, TEAM, tampered, tag)
    expect(ok).toBe(false)
  })

  it('verify rejects a wrong key', async () => {
    const body = new TextEncoder().encode('body').buffer as ArrayBuffer
    const tag = await computeArtifactTag(KEY, HASH, TEAM, body)
    const ok = await verifyArtifactTag('other-key', HASH, TEAM, body, tag)
    expect(ok).toBe(false)
  })

  it('verify rejects when hash differs', async () => {
    const body = new TextEncoder().encode('body').buffer as ArrayBuffer
    const tag = await computeArtifactTag(KEY, HASH, TEAM, body)
    const ok = await verifyArtifactTag(KEY, 'other-hash', TEAM, body, tag)
    expect(ok).toBe(false)
  })

  it('verify rejects when teamId differs', async () => {
    const body = new TextEncoder().encode('body').buffer as ArrayBuffer
    const tag = await computeArtifactTag(KEY, HASH, TEAM, body)
    const ok = await verifyArtifactTag(KEY, HASH, 'other-team', body, tag)
    expect(ok).toBe(false)
  })

  it('verify rejects malformed base64 tag without throwing', async () => {
    const body = new TextEncoder().encode('body').buffer as ArrayBuffer
    const ok = await verifyArtifactTag(KEY, HASH, TEAM, body, '!!!not-base64!!!')
    expect(ok).toBe(false)
  })
})
