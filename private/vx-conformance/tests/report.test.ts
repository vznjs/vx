import { expect, test } from 'bun:test'
import { renderReport, type Results } from '../src/report.ts'

const results = (choices?: Record<string, string>): Results => ({
  coverage: { ported: 0, rest: { pending: [], 'vx-only': [], internal: [], docs: [] } },
  tools: { a: '1', b: '1' },
  cases: [
    {
      id: 'logs/x',
      category: 'logs',
      kind: 'output',
      title: 'X',
      from: [],
      ...(choices ? { choices } : {}),
      outcomes: { a: { status: 'fail', detail: 'no' }, b: { status: 'pass' } },
    },
    {
      id: 'logs/y',
      category: 'logs',
      kind: 'output',
      title: 'Y',
      from: [],
      outcomes: { a: { status: 'pass' }, b: { status: 'pass' } },
    },
  ],
})

test('a failure a tool chose by design is reported, not scored', () => {
  expect(renderReport(results())).toContain('| **all** | 50% (1/2) | 100% (2/2) |')
  const md = renderReport(results({ a: 'prints one line' }))
  expect(md).toContain('| **all** | 100% (1/1) | 100% (2/2) |')
  expect(md).toContain('✗ **a**: no (by design, not scored: prints one line)')
})
