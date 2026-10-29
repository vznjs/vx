// ALLOW's entries, as @vzn/vx-dte-server reads them: issuer:owner/repo:workflow.

import { describe, expect, it } from 'bun:test'
import { parseAllow } from '../src/index.js'

const GITHUB = 'https://token.actions.githubusercontent.com'

describe('parseAllow', () => {
  it('takes issuer:owner/repo:workflow entries, space separated, and nothing less', () => {
    expect(parseAllow('')).toEqual([])
    expect(
      parseAllow(`${GITHUB}:acme/app:ci.yml\n https://gitlab.com:group/sub/app:.gitlab-ci.yml`),
    ).toEqual([
      { issuer: GITHUB, repository: 'acme/app', workflow: 'ci.yml' },
      { issuer: 'https://gitlab.com', repository: 'group/sub/app', workflow: '.gitlab-ci.yml' },
    ])
    for (const bad of [
      'acme/app',
      `${GITHUB}:acme/app`,
      `${GITHUB}:acme:ci.yml`,
      `${GITHUB}:acme/app:`,
      'http://x.example:acme/app:ci.yml',
    ])
      expect(() => parseAllow(bad)).toThrow(`${bad} is not issuer:owner/repo:workflow`)
    // One grammar on every server: a comma is not a separator, and an entry
    // that holds one is refused rather than read as a workflow named `ci.yml,`.
    expect(() => parseAllow(`${GITHUB}:acme/app:ci.yml,${GITHUB}:acme/web:ci.yml`)).toThrow(
      'entries are space separated',
    )
  })
})
