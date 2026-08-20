// `escapeLikePattern` — the one rule two surfaces share. Both the dashboard's
// project/task search box and this package's `--tag` read filter interpolate a
// user's string into a LIKE pattern, so `%` and `_` were wildcards on BOTH:
// searching `web_app` also matched `webXapp`, and a bare `%` matched every row.

import { describe, expect, it } from 'bun:test'
import { escapeLikePattern } from '../src/util/index.js'

describe('escapeLikePattern', () => {
  it('neutralises every LIKE metacharacter', () => {
    expect(escapeLikePattern('web_app')).toBe('web\\_app')
    expect(escapeLikePattern('100%')).toBe('100\\%')
    // The escape character itself must be escaped FIRST in effect, or a term
    // ending in a backslash would escape the wildcard the caller appends and
    // silently change the query's shape.
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\')
  })

  it('leaves an ordinary term byte-identical', () => {
    // The control: escaping must not degenerate into mangling every search.
    // Without this, "escape everything" could pass the assertions above while
    // making a plain `web` search stop matching `web-app`.
    for (const s of ['web', '@acme/ui', 'build', 'a-b.c', '', 'ünïcode', '#']) {
      expect(escapeLikePattern(s)).toBe(s)
    }
  })

  it('escapes only, leaving the surrounding wildcards to the caller', () => {
    // Documents the contract the two call sites rely on: they add their own
    // `%…%`, so this function must never introduce one.
    expect(escapeLikePattern('x')).not.toContain('%')
  })
})
