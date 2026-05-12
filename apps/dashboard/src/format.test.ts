import { describe, it, expect } from 'bun:test'
import {
  formatAge,
  formatBytes,
  formatDurationMs,
  formatPercent,
  formatRelativeTime,
  shortHash,
  shortRunId,
} from './format.ts'

describe('formatBytes', () => {
  it('emits B / KB / MB / GB with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })
  it('returns em-dash for null/undefined', () => {
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
  })
})

describe('formatDurationMs', () => {
  it('renders sub-ms, ms, seconds, and m+s', () => {
    expect(formatDurationMs(0.4)).toBe('<1ms')
    expect(formatDurationMs(42)).toBe('42ms')
    expect(formatDurationMs(1500)).toBe('1.50s')
    expect(formatDurationMs(125_000)).toBe('2m05s')
  })
  it('returns em-dash for null/undefined', () => {
    expect(formatDurationMs(null)).toBe('—')
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

describe('formatAge', () => {
  const now = new Date('2026-05-12T12:00:00Z').getTime()
  it('mirrors formatRelativeTime but takes ms-epoch from the API', () => {
    expect(formatAge(now - 1_000, now)).toBe('just now')
    expect(formatAge(now - 30_000, now)).toBe('30s ago')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatAge(now - 2 * 3_600_000, now)).toBe('2h ago')
    expect(formatAge(now - 3 * 86_400_000, now)).toBe('3d ago')
  })
  it('returns em-dash for null/undefined', () => {
    expect(formatAge(null)).toBe('—')
  })
  it('handles future timestamps gracefully', () => {
    expect(formatAge(now + 10_000, now)).toBe('in the future')
  })
})

describe('formatPercent', () => {
  it('renders fraction → one-decimal percentage', () => {
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(0.5)).toBe('50.0%')
    expect(formatPercent(0.873)).toBe('87.3%')
    expect(formatPercent(1)).toBe('100.0%')
  })
  it('returns em-dash for null/undefined', () => {
    expect(formatPercent(null)).toBe('—')
  })
})

describe('shortHash / shortRunId', () => {
  it('truncates to 10 chars, em-dash on null', () => {
    expect(shortHash('abcdef1234567890')).toBe('abcdef1234')
    expect(shortHash(null)).toBe('—')
    expect(shortRunId('01H8KGZQX9VJP3RM7Y2N4WCBTF')).toBe('01H8KGZQX9')
    expect(shortRunId(undefined)).toBe('—')
  })
})
