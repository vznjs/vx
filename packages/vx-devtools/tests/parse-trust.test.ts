// TRUST's rules: each names an issuer, one repository and the refs it protects.

import { describe, expect, it } from 'bun:test'
import { parseTrust } from '../src/index.js'

const GITHUB = 'https://token.actions.githubusercontent.com'

describe('parseTrust', () => {
  it('takes rules naming the repository and the refs they protect, and nothing less', () => {
    expect(parseTrust('')).toEqual([])
    expect(() => parseTrust('{}')).toThrow('not a JSON list of rules')
    expect(() => parseTrust('[{"iss":"http://x","project_id":"1","ref_path":"r"}]')).toThrow(
      'rule 0: iss is not an https:// issuer',
    )
    expect(() => parseTrust(`[{"iss":"${GITHUB}","ref":"refs/heads/main"}]`)).toThrow(
      'rule 0: names no repository_id (one repository, no *)',
    )
    expect(() => parseTrust(`[{"iss":"${GITHUB}","repository_id":"4*","ref":"r"}]`)).toThrow(
      'rule 0: names no repository_id (one repository, no *)',
    )
    expect(() => parseTrust('[{"iss":"https://gitlab.com","project_id":"1"}]')).toThrow(
      'rule 0: names no ref_path (the refs it protects)',
    )
    expect(() =>
      parseTrust(`[{"iss":"${GITHUB}","repository_id":"4","ref":"r","event_name":[]}]`),
    ).toThrow('rule 0: event_name is not a string or a list of them')
    // One id under two issuers is two repositories: each lives under its issuer.
    expect(
      parseTrust(
        `[{"iss":"${GITHUB}","repository_id":"4","ref":"r"},{"iss":"https://gitlab.com","project_id":"4","ref_path":"r"}]`,
      ),
    ).toHaveLength(2)
  })
})
