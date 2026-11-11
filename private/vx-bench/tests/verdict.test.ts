import { expect, it } from 'bun:test'
import { verdict } from '../real/verdict.js'

it('rounds a win down, never up', () => {
  expect(verdict({ tool: 'turbo', vx: 1000, rival: 1099 })).toBe('9% faster')
  expect(verdict({ tool: 'turbo', vx: 1000, rival: 1999 })).toBe('99% faster')
  expect(verdict({ tool: 'turbo', vx: 1000, rival: 2999 })).toBe('2.9× faster')
  expect(verdict({ tool: 'turbo', vx: 100, rival: 157 })).toBe('57% faster')
  expect(verdict({ tool: 'turbo', vx: 1000, rival: 2000 })).toBe('2.0× faster')
})

it('rounds a loss down too', () => {
  expect(verdict({ tool: 'nx', vx: 1099, rival: 1000 })).toBe('LOSS: nx 9% faster')
})
