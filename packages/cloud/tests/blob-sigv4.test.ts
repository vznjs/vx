// The hand-rolled SigV4 signer (src/blob/sigv4.ts), pinned against the AWS
// documentation's published test vectors ("Authenticating Requests" — the
// examplebucket examples with the documented AKIAIOSFODNN7EXAMPLE
// credentials), plus canonical-encoding edges and a computed-once self-KAT
// so a regression in either signing form fails loudly.

import { describe, expect, it } from 'bun:test'
import { awsUriEncode, presignUrl, signRequest, UNSIGNED_PAYLOAD } from '../src/blob/sigv4.js'

const AWS_DOC_CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
}
const AWS_DOC_DATE = new Date('2013-05-24T00:00:00Z')
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('presignUrl — the AWS docs query-parameters vector', () => {
  it('reproduces the presigned GET of examplebucket/test.txt byte-for-byte', () => {
    const url = presignUrl({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      ...AWS_DOC_CREDS,
      expiresSeconds: 86400,
      date: AWS_DOC_DATE,
    })
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    )
  })

  it('preserves / in the path but AWS-encodes each segment (self-KAT)', () => {
    const url = presignUrl({
      method: 'GET',
      url: new URL('https://minio.internal:9000/vx-cache/default/trusted/a%20b%3Dc.tar.zst'),
      region: 'auto',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      expiresSeconds: 300,
      date: new Date('2026-07-11T12:00:00Z'),
    })
    expect(url).toBe(
      'https://minio.internal:9000/vx-cache/default/trusted/a%20b%3Dc.tar.zst' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=test-key%2F20260711%2Fauto%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20260711T120000Z' +
        '&X-Amz-Expires=300' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=3440660d37d06187de74cc59d6696aa658a36c686a2650282a4c22ee315dce5e',
    )
  })
})

describe('signRequest — the AWS docs authorization-header vectors', () => {
  it('reproduces the GET-object vector (Range header, empty payload)', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      ...AWS_DOC_CREDS,
      payloadSha256: EMPTY_SHA256,
      date: AWS_DOC_DATE,
    })
    expect(headers['host']).toBe('examplebucket.s3.amazonaws.com')
    expect(headers['x-amz-date']).toBe('20130524T000000Z')
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_SHA256)
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('reproduces the PUT-object vector — `$` in the key is %24 in the canonical URI', () => {
    const args = {
      method: 'PUT',
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      },
      ...AWS_DOC_CREDS,
      payloadSha256: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      date: AWS_DOC_DATE,
    }
    const expected =
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
      'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,' +
      'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'
    const encoded = signRequest({
      ...args,
      url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
    })
    expect(encoded['authorization']).toBe(expected)
    // Canonicalization pin: a raw `$` in the URL signs identically to its
    // pre-encoded form — the signer re-canonicalizes each segment.
    const raw = signRequest({
      ...args,
      url: new URL('https://examplebucket.s3.amazonaws.com/test$file.text'),
    })
    expect(raw['authorization']).toBe(expected)
  })

  it('reproduces the GET-lifecycle vector (query param with an empty value)', () => {
    const headers = signRequest({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      ...AWS_DOC_CREDS,
      payloadSha256: EMPTY_SHA256,
      date: AWS_DOC_DATE,
    })
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date,' +
        'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    )
  })

  it('signs x-amz-meta-* headers and defaults to UNSIGNED-PAYLOAD (self-KAT)', () => {
    const headers = signRequest({
      method: 'PUT',
      url: new URL('https://minio.internal:9000/vx-cache/default/trusted/a1b2c3d4e5f60718.tar.zst'),
      headers: {
        'x-amz-meta-vx-digest': 'xxh3:00ff00ff00ff00ff',
        'x-amz-meta-vx-duration-ms': '42',
      },
      region: 'auto',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      date: new Date('2026-07-11T12:00:00Z'),
    })
    expect(headers['x-amz-content-sha256']).toBe(UNSIGNED_PAYLOAD)
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=test-key/20260711/auto/s3/aws4_request,' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-vx-digest;x-amz-meta-vx-duration-ms,' +
        'Signature=f8df0b40ca9a282d8698bb5373ccfc695ed281b53e84a9bb6fa0e2a592e5581e',
    )
  })
})

describe('awsUriEncode — the canonical encoding rule', () => {
  it('leaves the unreserved set untouched', () => {
    const unreserved = 'ABCXYZabcxyz0189-._~'
    expect(awsUriEncode(unreserved)).toBe(unreserved)
  })

  it('encodes everything else with uppercase hex, including chars encodeURIComponent skips', () => {
    expect(awsUriEncode('a b')).toBe('a%20b')
    expect(awsUriEncode('a=b')).toBe('a%3Db')
    expect(awsUriEncode('a/b')).toBe('a%2Fb')
    expect(awsUriEncode("!*'()")).toBe('%21%2A%27%28%29')
    expect(awsUriEncode('a+b')).toBe('a%2Bb')
  })
})

// The LIST path is the only request shape whose query string is built by the
// caller and carries a value it does not control: S3's continuation token is
// opaque base64, so it contains `+`, `/` and `=`. That is exactly where the
// wire form and the canonical form can drift apart — and the drift is only
// reachable on a bucket large enough to paginate, i.e. production and never a
// fixture. Page 1 would work and every page after it would 403.
describe('the LIST query survives a base64 continuation token', () => {
  // Mirrors `S3Backend.list`: each side AWS-encoded BEFORE the URL is built.
  const listUrl = (token?: string): URL => {
    const params: [string, string][] = [
      ['list-type', '2'],
      ['prefix', 'org/1-2/ws/_org/trusted/'],
    ]
    if (token !== undefined) params.push(['continuation-token', token])
    const query = params.map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&')
    return new URL(`http://s3.local/bkt/?${query}`)
  }

  it('round-trips +, / and = through the URL back to the canonical form', () => {
    // The signer re-derives the canonical query from `url.searchParams`, so a
    // value only signs correctly if parsing the wire form returns it verbatim.
    const token = 'a+b/c=d=='
    const parsed = [...listUrl(token).searchParams]
    expect(parsed).toEqual([
      ['list-type', '2'],
      ['prefix', 'org/1-2/ws/_org/trusted/'],
      ['continuation-token', token],
    ])
  })

  it('the caller’s pre-encoding is load-bearing: a raw + would parse as a SPACE', () => {
    // Why `list` encodes each side itself rather than handing raw values to
    // URLSearchParams: in a query string JS applies form-urlencoded semantics,
    // where `+` means space — but AWS/RFC3986 treat it as a literal. A raw `+`
    // would canonicalize to %20 while S3 signed %2B, and the LIST would 403.
    expect([...new URL('http://h/b/?tok=a+b').searchParams][0]).toEqual(['tok', 'a b'])
    // Pre-encoded, the same byte survives.
    expect([...new URL(`http://h/b/?tok=${awsUriEncode('a+b')}`).searchParams][0]).toEqual([
      'tok',
      'a+b',
    ])
  })

  it('signs a paginated LIST to a pinned signature (self-KAT)', () => {
    // Computed once against this implementation. AWS publishes no LIST vector,
    // so this is the only thing that makes ANY canonicalization change — the
    // param sort, the per-side encoding, the path form — fail here rather than
    // in production on page 2 of a large bucket.
    const signed = signRequest({
      method: 'GET',
      url: listUrl('a+b/c=d'),
      ...AWS_DOC_CREDS,
      date: AWS_DOC_DATE,
    })
    expect(signed.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date,' +
        'Signature=3addcbdb049766054c3cfc2d6bbaf80f8cc81225e8e6faea61e18ba1b4f13810',
    )
    // A token differing only by +-vs-space must sign differently — the two are
    // distinct bytes to S3, and collapsing them anywhere would 403 the page.
    const withSpace = signRequest({
      method: 'GET',
      url: listUrl('a b/c=d'),
      ...AWS_DOC_CREDS,
      date: AWS_DOC_DATE,
    })
    expect(withSpace.authorization).not.toBe(signed.authorization)
  })
})

describe('presigned GET of a real cache-artifact key', () => {
  it('keeps the scope separators literal and the wire URL byte-equal to the canonical one', () => {
    // The tenant-partitioned layout from the artifact store. `/` must stay a
    // separator (an escaped %2F would address a completely different object),
    // and the returned URL must be the string that was signed.
    const key = '/bkt/org/8a1f/ws/_org/untrusted/pr-42/0123abcd.tar.zst'
    const signed = presignUrl({
      method: 'GET',
      url: new URL(`http://s3.local${key}`),
      expiresSeconds: 300,
      ...AWS_DOC_CREDS,
      date: AWS_DOC_DATE,
    })
    expect(new URL(signed).pathname).toBe(key)
    expect(signed.split('?')[0]).toBe(`http://s3.local${key}`)
    expect(signed).toContain('X-Amz-Expires=300')
    expect(signed).toContain(`X-Amz-SignedHeaders=host`)
  })
})
