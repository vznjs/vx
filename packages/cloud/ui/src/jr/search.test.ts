// The filter box's `?q` → server-search plumbing. `searchOf` is what turns a
// debounced keystroke in the URL into the `search=` the Projects/Tasks list
// sources send, and `pageNote` is the truncation notice that has to stay
// honest once the box reaches past the fetched page.

import { describe, expect, it } from 'bun:test'
import { LIST_PAGE, pageNote, searchOf } from './data.ts'

describe('searchOf', () => {
  it('reads the ?q param and trims it', () => {
    expect(searchOf({ q: 'orders' })).toBe('orders')
    expect(searchOf({ q: '  orders#build  ' })).toBe('orders#build')
  })

  it('is empty when the param is absent or blank — no search is sent', () => {
    expect(searchOf({})).toBe('')
    expect(searchOf({ q: '' })).toBe('')
    expect(searchOf({ q: '   ' })).toBe('')
    // Other loader params (the timeframe token) never leak into the search.
    expect(searchOf({ window: '7d' })).toBe('')
  })
})

describe('pageNote', () => {
  it('with no search, the workspace total is the denominator', () => {
    const full = pageNote('', LIST_PAGE, 620)
    expect(full._truncated).toBe(true)
    expect(full._note).toBe(
      `showing ${LIST_PAGE} of 620 projects — the filter box searches all of them`,
    )
    // Nothing left out ⇒ no notice at all.
    expect(pageNote('', 12, 12)._truncated).toBe(false)
  })

  it('with a search, the note counts MATCHES — the workspace total is not its denominator', () => {
    // 3 matches out of a 620-project workspace is complete, not truncated: the
    // pre-search rule (`total > shown`) would have cried truncation here.
    const few = pageNote('needle', 3, 620)
    expect(few._truncated).toBe(false)
    expect(few._note).toContain('showing the first 3 matches for “needle”')
    // A full page of matches IS truncated — more matches exist off the page.
    expect(pageNote('pkg', LIST_PAGE, 620)._truncated).toBe(true)
  })
})
