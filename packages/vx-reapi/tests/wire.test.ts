// Unit coverage that needs no server. The integration round-trip lives in
// reapi-e2e.test.ts and is gated on a real endpoint.

import { describe, expect, it } from 'bun:test'
import {
  assertBunSupportsChunking,
  CHUNK_BYTES,
  MIN_BUN,
  ReapiClient,
  SAFE_CHUNK_BYTES,
} from '../src/wire.js'
import { actionDigestFor, digestOf } from '../src/cache.js'

describe('CHUNK_BYTES', () => {
  // This is the constant a well-meaning "optimisation" raises. The failure it
  // guards is a HANG, not an error, so a reviewer gets no signal from a test
  // suite that merely still passes — hence an explicit pin with the reason.
  it('is 128 KB — the Bun http2 ceiling, not a throughput knob', () => {
    expect(CHUNK_BYTES).toBe(128 * 1024)
  })

  it('stays at or below the smallest threshold the supported Bun range allows', () => {
    // Bun 1.4.0 hangs above ~192-256 KB per message; 1.3.x hangs above ~64 KB.
    // MIN_BUN is 1.4.0 precisely so 128 KB is inside the window. If someone
    // lowers MIN_BUN back to 1.3, this fails and points at the real conflict
    // rather than letting uploads wedge in the field.
    const [maj, min] = MIN_BUN
    const ceiling = maj > 1 || (maj === 1 && min >= 4) ? 192 * 1024 : 64 * 1024
    expect(CHUNK_BYTES).toBeLessThanOrEqual(ceiling)
  })
})

describe('assertBunSupportsChunking', () => {
  it('refuses a Bun older than MIN_BUN, naming the fix', () => {
    // A hang gives a user nothing to act on, so the version check has to be
    // the thing that speaks.
    expect(() => assertBunSupportsChunking('1.3.14')).toThrow(/needs Bun >= 1\.4\.0/)
    expect(() => assertBunSupportsChunking('1.3.14')).toThrow(/bun upgrade/)
    expect(() => assertBunSupportsChunking('0.9.9')).toThrow(/needs Bun/)
  })

  it('accepts MIN_BUN exactly and anything newer', () => {
    // The false-positive control: a refusal that also refuses valid versions
    // is just a broken plugin.
    expect(() => assertBunSupportsChunking('1.4.0')).not.toThrow()
    expect(() => assertBunSupportsChunking('1.4.1')).not.toThrow()
    expect(() => assertBunSupportsChunking('1.10.0')).not.toThrow()
    expect(() => assertBunSupportsChunking('2.0.0')).not.toThrow()
  })

  it('accepts the Bun actually running this suite', () => {
    // Guards the parser against a real-world version string shape.
    expect(() => assertBunSupportsChunking()).not.toThrow()
  })
})

describe('actionDigestFor', () => {
  it('is deterministic and distinct per vx key', () => {
    expect(actionDigestFor('abc')).toEqual(actionDigestFor('abc'))
    expect(actionDigestFor('abc').hash).not.toBe(actionDigestFor('abd').hash)
  })

  it('is namespaced so a vx key cannot collide with a real Bazel action', () => {
    // A REAPI server may be shared with Bazel itself. Addressing an AC entry
    // by the bare sha256 of our key would put vx artifacts in the same
    // address space as real action digests.
    const key = 'deadbeef'
    const bare = digestOf(new TextEncoder().encode(key))
    expect(actionDigestFor(key).hash).not.toBe(bare.hash)
  })

  it('carries a scheme version, so changing the mapping misses instead of lying', () => {
    // The prefix is what makes a future mapping change SELF-HEALING: new
    // address, clean miss, re-upload — rather than reading bytes written
    // under different rules.
    const v1 = new TextEncoder().encode('vx-reapi-v1\0k')
    expect(actionDigestFor('k')).toEqual(digestOf(v1))
  })
})

describe('digestOf', () => {
  it('is the sha256 and byte length REAPI expects', () => {
    const body = new TextEncoder().encode('hello')
    const d = digestOf(body)
    expect(d.size_bytes).toBe(5)
    expect(d.hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('distinguishes contents of equal length', () => {
    expect(digestOf(new TextEncoder().encode('aaaa')).hash).not.toBe(
      digestOf(new TextEncoder().encode('aaab')).hash,
    )
  })
})

describe('SAFE_CHUNK_BYTES', () => {
  it('is the RFC 7540 default initial window', () => {
    // The one size needing no WINDOW_UPDATE from any conformant peer, and so
    // the only value with no peer-dependence. The escape hatch when a server's
    // flow-control behaviour trips the Bun defect.
    expect(SAFE_CHUNK_BYTES).toBe(65535)
  })

  it('is below the default, so the escape hatch actually escapes', () => {
    expect(SAFE_CHUNK_BYTES).toBeLessThan(CHUNK_BYTES)
  })
})

describe('chunkBytes option', () => {
  it('rejects a non-positive or fractional size rather than wedging later', () => {
    // A bad chunk size does not error at the wire — it produces a malformed
    // or infinite write loop. Validate at construction where it is nameable.
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new ReapiClient({ endpoint: '127.0.0.1:1', chunkBytes: bad })).toThrow(
        /chunkBytes must be a positive integer/,
      )
    }
  })

  it('accepts SAFE_CHUNK_BYTES and the default', () => {
    // False-positive control: the validator must not reject the two values
    // the docs tell people to use.
    for (const ok of [SAFE_CHUNK_BYTES, CHUNK_BYTES]) {
      const client = new ReapiClient({ endpoint: '127.0.0.1:1', chunkBytes: ok })
      client.close()
    }
  })
})
