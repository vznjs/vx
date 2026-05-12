import { describe, it, expect } from 'bun:test'
import { formatBytes, formatDurationMs, formatRelativeTime } from './format.ts'

describe('formatBytes', () => {
  it('emits B / KB / MB / GB with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})

describe('formatDurationMs', () => {
  it('renders sub-ms, ms, seconds, and m+s', () => {
    expect(formatDurationMs(0.4)).toBe('<1ms')
    expect(formatDurationMs(42)).toBe('42ms')
    expect(formatDurationMs(1500)).toBe('1.50s')
    expect(formatDurationMs(125_000)).toBe('2m05s')
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-05-12T12:00:00Z')
  it('handles seconds, minutes, hours, days', () => {
    expect(formatRelativeTime(new Date('2026-05-12T11:59:58Z'), now)).toBe('just now')
    expect(formatRelativeTime(new Date('2026-05-12T11:59:30Z'), now)).toBe('30s ago')
    expect(formatRelativeTime(new Date('2026-05-12T11:55:00Z'), now)).toBe('5m ago')
    expect(formatRelativeTime(new Date('2026-05-12T10:00:00Z'), now)).toBe('2h ago')
    expect(formatRelativeTime(new Date('2026-05-09T12:00:00Z'), now)).toBe('3d ago')
  })
})
