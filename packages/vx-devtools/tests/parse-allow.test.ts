// ALLOW's entries, as @vzn/vx-dte-server reads them: issuer:owner/repo:workflow.

import { describe, expect, it } from 'bun:test'
import { parseAllow } from '../src/index.js'

const GITHUB = 'https://token.actions.githubusercontent.com'

describe('parseAllow', () => {
  it('takes issuer:owner/repo:workflow entries, space or comma separated, and nothing less', () => {
    expect(parseAllow('')).toEqual([])
    expect(
      parseAllow(`${GITHUB}:acme/app:ci.yml, https://gitlab.com:group/sub/app:.gitlab-ci.yml`),
    ).toEqual([
      { issuer: GITHUB, repository: 'acme/app', workflow: 'ci.yml' },
      { issuer: 'https://gitlab.com', repository: 'group/sub/app', workflow: '.gitlab-ci.yml' },
    ])
    for (const bad of [
      'acme/app',
      `${GITHUB}:acme/app`,
      `${GITHUB}:acme:ci.yml`,
      `${GITHUB}:acme/app:`,
    ])
      expect(() => parseAllow(bad)).toThrow(new Error(`${bad} is not issuer:owner/repo:workflow`))
    // Well formed, so "is not issuer:owner/repo:workflow" sent its author to the wrong part.
    for (const [bad, issuer] of [
      ['http://x.example:acme/app:ci.yml', 'http://x.example'],
      // Plain HTTP to another host, behind loopback's spelling.
      ['http://127.0.0.1:80@x.example:acme/app:ci.yml', 'http://127.0.0.1:80@x.example'],
      ['http://127.0.0.1.x.example:acme/app:ci.yml', 'http://127.0.0.1.x.example'],
    ] as const)
      expect(() => parseAllow(bad)).toThrow(
        new Error(`${bad}: the issuer is https://, not ${issuer} (plain http only on 127.0.0.1)`),
      )
  })
})
