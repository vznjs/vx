// The org/workspace clamp + org-selection reconciliation are the load-bearing
// pure logic of the session/account client (cloud-platform-2026-07 §6): every
// analytics read routes through scopedPathFor, and the switcher's selection
// must survive an org list refresh. Pinned here so a regression can't silently
// drop the tenant clamp.

import { describe, expect, it } from 'bun:test'
import { nextOrgSelection, scopedPathFor } from './api.ts'

describe('scopedPathFor', () => {
  const ORG = 'o1'
  const WS = 'w1'

  it('appends org + ws to an analytics read', () => {
    expect(scopedPathFor('/v1/runs', ORG, WS)).toBe('/v1/runs?org=o1&ws=w1')
  })

  it('joins with & when the path already has a query', () => {
    expect(scopedPathFor('/v1/runs?limit=50', ORG, WS)).toBe('/v1/runs?limit=50&org=o1&ws=w1')
  })

  it('never scopes /v1/workspaces by a workspace (org only)', () => {
    expect(scopedPathFor('/v1/workspaces', ORG, WS)).toBe('/v1/workspaces?org=o1')
  })

  it('leaves /v1/meta untouched (auth-exempt, no tenant clamp)', () => {
    expect(scopedPathFor('/v1/meta', ORG, WS)).toBe('/v1/meta')
  })

  it('leaves auth + admin routes untouched (scope in body/path)', () => {
    expect(scopedPathFor('/v1/auth/me', ORG, WS)).toBe('/v1/auth/me')
    expect(scopedPathFor('/v1/admin/orgs', ORG, WS)).toBe('/v1/admin/orgs')
    expect(scopedPathFor('/v1/admin/orgs/o1/tokens', ORG, WS)).toBe('/v1/admin/orgs/o1/tokens')
  })

  it('omits an empty org / empty workspace', () => {
    expect(scopedPathFor('/v1/runs', ORG, '')).toBe('/v1/runs?org=o1')
    expect(scopedPathFor('/v1/runs', '', '')).toBe('/v1/runs')
  })

  it('leaves non-/v1 paths (SPA, /version) alone', () => {
    expect(scopedPathFor('/version', ORG, WS)).toBe('/version')
    expect(scopedPathFor('/', ORG, WS)).toBe('/')
  })

  it('url-encodes the ids', () => {
    expect(scopedPathFor('/v1/runs', 'a b', 'c&d')).toBe('/v1/runs?org=a%20b&ws=c%26d')
  })
})

describe('nextOrgSelection', () => {
  const orgs = [{ id: 'a' }, { id: 'b' }]

  it('keeps a still-valid selection', () => {
    expect(nextOrgSelection(orgs, 'b')).toBe('b')
  })

  it('falls back to the first org when the selection is unknown', () => {
    expect(nextOrgSelection(orgs, 'gone')).toBe('a')
  })

  it('picks the first org when none is selected', () => {
    expect(nextOrgSelection(orgs, '')).toBe('a')
  })

  it('clears the selection when the principal has no orgs', () => {
    expect(nextOrgSelection([], 'a')).toBe('')
    expect(nextOrgSelection([], '')).toBe('')
  })
})
