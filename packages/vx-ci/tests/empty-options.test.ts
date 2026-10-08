// An empty string passed the option kind check and was misread: summaryFile
// '' declined instead of falling back to GITHUB_STEP_SUMMARY, checkName ''
// POSTed a name GitHub refuses, title '' rendered an empty heading.
import { expect, it } from 'bun:test'
import { github } from '../src/index.js'

const refusal = (make: () => unknown): string => {
  try {
    make()
    return 'taken'
  } catch (err) {
    return (err as Error).message
  }
}

it('an empty string option is refused, naming it', () => {
  expect(refusal(() => github({ summaryFile: '' }))).toBe(
    'github() option "summaryFile" must be a non-empty string, got ""',
  )
  expect(refusal(() => github({ title: '' }))).toBe(
    'github() option "title" must be a non-empty string, got ""',
  )
  expect(refusal(() => github({ checkName: '' }))).toBe(
    'github() option "checkName" must be a non-empty string, got ""',
  )
})

it('non-empty strings are taken', () => {
  expect(refusal(() => github({ summaryFile: 'f.md', title: 't', checkName: 'c' }))).toBe('taken')
})
